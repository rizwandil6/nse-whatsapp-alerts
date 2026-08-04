'use strict';

/**
 * Live PDH/PDL break-&-retest scalp scanner for the halal Nifty-50 subset.
 *
 * Connects to Upstox's official V3 market-data WebSocket, decodes 1-min OHLC
 * candles (Protobuf), aggregates each symbol into BOTH 5-min (entry) and
 * 15-min (confirmation) bars, and drives a per-symbol PdhPdlTracker:
 *   • a 15-min close beyond the prior day's high/low ARMS a bias,
 *   • a 5-min retest confirmed by a one-shot pin bar or an engulfing candle
 *     is the SETUP (entry), tracked to 1.5R / 2R / 3R / SL / EOD.
 * Alerts go to Telegram (personal + group). Everything is persisted to
 * Postgres (pdh_pdl.*) as a forward-test dataset.
 *
 * Alert-only. NO orders are ever placed.
 *
 * Requires: UPSTOX_ACCESS_TOKEN (daily-refreshed, same as the other bots),
 *           TELEGRAM_BOT_TOKEN, and DATABASE_URL (or .secrets/pg_url.txt).
 *
 * Strategy source: wiki/concepts/pdh-pdl-break-retest-scalp.md
 * Script decode:   wiki/reference/tws-pdh-pdl-pine-scripts.md
 */

const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('path');

const { BarAggregator } = require('./bar_aggregator');
const { PdhPdlTracker, istMin } = require('./pdh_pdl_engine');
const { fetchLevels } = require('./prev_day_levels');
const { DB } = require('./db');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046']; // personal + group (same as ema-scalp)
// Variant config: MIN_R_PCT>0 activates pdhpdl-v2 (min-R filter) — small-R setups
// are still logged + tracked but not alerted. CONFIG_TAG stamps the DB rows.
const MIN_R_PCT = parseFloat(process.env.MIN_R_PCT || '0') || 0;
const CONFIG_TAG = process.env.CONFIG_TAG || 'pdhpdl-v1';
const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const IST_OFFSET_MS = 5.5 * 3600000;

if (!UPSTOX_TOKEN) { console.error('FATAL: UPSTOX_ACCESS_TOKEN not set.'); process.exit(1); }
if (!TELEGRAM_TOKEN) console.warn('WARNING: TELEGRAM_BOT_TOKEN not set. Alerts logged, not sent.');

const symbolMap = require('./symbols.json');
const keyToSymbol = {};
for (const [symbol, key] of Object.entries(symbolMap)) keyToSymbol[key] = symbol;

const db = new DB();

let protobufRoot = null;
const trackers = {};   // symbol -> PdhPdlTracker
const agg5 = {};       // symbol -> BarAggregator(5)
const agg15 = {};      // symbol -> BarAggregator(15)
const signalIds = {};  // symbol -> Postgres signals.id
const alertedBySymbol = {}; // symbol -> whether its setup passed the min-R gate (drives milestone/outcome alerts)
let lastPreppedDate = null;

function istDate(ms) { return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10); }
function istTimeStr(ms) { return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16); }
function todayIst() { return istDate(Date.now()); }

// ---- daily prep: (re)fetch PDH/PDL and reset trackers ----------------------
async function prepDay() {
  const date = todayIst();
  console.log(`Prepping ${date}: fetching prior-day PDH/PDL for ${Object.keys(symbolMap).length} symbols...`);
  const { levels, failed } = await fetchLevels(symbolMap, UPSTOX_TOKEN);
  for (const symbol of Object.keys(symbolMap)) {
    trackers[symbol] = new PdhPdlTracker(symbol, { minRPct: MIN_R_PCT });
    agg5[symbol] = new BarAggregator(5, (bar) => handle5(symbol, bar));
    agg15[symbol] = new BarAggregator(15, (bar) => handle15(symbol, bar));
    delete signalIds[symbol];
    delete alertedBySymbol[symbol];
    const lv = levels[symbol];
    if (lv) trackers[symbol].setLevels(lv.pdh, lv.pdl);
  }
  lastPreppedDate = date;
  const ok = Object.keys(levels).length;
  console.log(`  levels set for ${ok}/${Object.keys(symbolMap).length} symbols` + (failed.length ? `; failed: ${failed.join(', ')}` : ''));
}

/** Runs every minute: (re)prep once per day at/after 09:10 IST. */
function scheduleDailyPrep() {
  setInterval(() => {
    const now = Date.now();
    if (istDate(now) !== lastPreppedDate && istMin(now) >= 9 * 60 + 10) {
      prepDay().catch((e) => console.error('prepDay failed:', e.message));
    }
  }, 60000);
}

// ---- Upstox feed plumbing (mirrors ema-scalp/live/streamer.js) --------------
async function getMarketFeedUrl() {
  const res = await fetch(AUTHORIZE_URL, { headers: { Accept: 'application/json', Authorization: `Bearer ${UPSTOX_TOKEN}` } });
  if (!res.ok) throw new Error(`Authorize failed: HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  return body.data.authorizedRedirectUri || body.data.authorized_redirect_uri;
}
async function initProtobuf() { protobufRoot = await protobuf.load(path.join(__dirname, 'MarketDataFeedV3.proto')); }
function decodeProtobuf(buffer) {
  const FeedResponse = protobufRoot.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
  return FeedResponse.toObject(FeedResponse.decode(buffer), { longs: Number, enums: String, defaults: true });
}
function extractOneMinCandles(feed) {
  const inner = feed.fullFeed && (feed.fullFeed.marketFF || feed.fullFeed.indexFF);
  if (!inner || !inner.marketOHLC || !inner.marketOHLC.ohlc) return [];
  return inner.marketOHLC.ohlc.filter((o) => o.interval === 'I1').map((o) => ({
    timestampMs: Number(o.ts), open: o.open, high: o.high, low: o.low, close: o.close, volume: Number(o.vol || 0),
  }));
}

// ---- Telegram --------------------------------------------------------------
async function sendTelegram(text) {
  console.log('[ALERT]', text.replace(/\n/g, ' | '));
  if (!TELEGRAM_TOKEN) return false;
  let allOk = true;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) { allOk = false; console.warn(`  Telegram send failed for ${chatId}: HTTP ${res.status}`); }
    } catch (e) { allOk = false; console.warn(`  Telegram send error for ${chatId}: ${e.message}`); }
  }
  return allOk;
}

const f = (x) => (x == null ? '—' : Number(x).toFixed(2));

function fmtArmed(e) {
  return [`⚡ PDH/PDL ARMED — ${e.symbol} (${e.direction})`,
    `${e.levelType} ${f(e.level)} broken (15m close ${f(e.breakClose)}) at ${istTimeStr(e.breakTs)} IST.`,
    `Watch for the ${e.direction === 'LONG' ? '5-min retest of PDH' : '5-min retest of PDL'}.`].join('\n');
}
function fmtSetup(e) {
  return [`${e.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} SETUP — ${e.symbol}`,
    `Trigger: ${e.triggerType === 'PIN' ? 'one-shot pin bar' : 'engulfing'} at ${e.levelType} ${f(e.level)}` +
      (e.effRatio != null ? ` (eff ${Number(e.effRatio).toFixed(2)})` : ''),
    `Entry ${f(e.entryPx)}  |  SL ${f(e.sl)}  (R ${f(e.r)} · ${e.rPct != null ? e.rPct.toFixed(2) : '?'}%)`,
    `T 1.5R ${f(e.t1p5)}   T 2R ${f(e.t2)}   T 3R ${f(e.t3)}`,
    `${istTimeStr(e.entryTs)} IST · alert-only, no order placed.`].join('\n');
}
function fmtMilestone(e) {
  return `🎯 ${e.symbol} reached ${e.level} @ ${f(e.price)} (${istTimeStr(e.ts)} IST).` +
    (e.level === 'T1.5R' ? ' Consider trailing SL to breakeven.' : '');
}
function fmtOutcome(e) {
  const icon = e.result === 'T3R' ? '✅' : e.result === 'SL' ? '🛑' : '⏹️';
  return [`${icon} ${e.symbol} closed — ${e.result} @ ${f(e.exitPx)}`,
    `R-multiple: ${e.rMultiple >= 0 ? '+' : ''}${Number(e.rMultiple).toFixed(2)}R  ·  MFE ${Number(e.mfeR).toFixed(2)}R / MAE ${Number(e.maeR).toFixed(2)}R`,
    `${istTimeStr(e.closedTs)} IST.`].join('\n');
}

// ---- event handling --------------------------------------------------------
async function emit(alertType, symbol, text, signalId) {
  const ok = await sendTelegram(text);
  await db.insertAlert({ signalId, symbol, alertType, chatId: TELEGRAM_CHAT_IDS.join(','), text, sentOk: ok });
}

async function handleEvents(events) {
  for (const e of events) {
    if (e.type === 'ARMED') {
      const td = istDate(e.breakTs);
      await db.insertArmed(e, td);
      await emit('ARMED', e.symbol, fmtArmed(e), null);
    } else if (e.type === 'SETUP') {
      const td = istDate(e.entryTs);
      const id = await db.insertSignal(e, td);       // always logged (v1 record + counterfactual)
      if (id != null) signalIds[e.symbol] = id;
      alertedBySymbol[e.symbol] = e.alerted !== false;
      if (alertedBySymbol[e.symbol]) await emit('SETUP', e.symbol, fmtSetup(e), signalIds[e.symbol]);
      else console.log(`[pdh-pdl] SETUP suppressed (min-R) ${e.symbol} R=${e.rPct != null ? e.rPct.toFixed(2) : '?'}% < ${MIN_R_PCT}%`);
    } else if (e.type === 'MILESTONE') {
      await db.markMilestone(signalIds[e.symbol], e.level, e.ts);            // always tracked
      if (alertedBySymbol[e.symbol]) await emit(e.level, e.symbol, fmtMilestone(e), signalIds[e.symbol]);
    } else if (e.type === 'OUTCOME') {
      await db.closeOutcome(signalIds[e.symbol], e);                          // always tracked
      if (alertedBySymbol[e.symbol]) await emit(e.result, e.symbol, fmtOutcome(e), signalIds[e.symbol]);
    }
  }
}

// Serialize event handling per symbol so a signal's INSERT always completes
// before its outcome UPDATE (handleEvents is async; aggregator callbacks are sync).
const chains = {};
function enqueue(symbol, events) {
  if (!events || events.length === 0) return;
  chains[symbol] = (chains[symbol] || Promise.resolve())
    .then(() => handleEvents(events))
    .catch((e) => console.error(`handleEvents error [${symbol}]:`, e.message));
}
function handle5(symbol, bar) { const t = trackers[symbol]; if (t) enqueue(symbol, t.onNew5mBar(bar)); }
function handle15(symbol, bar) { const t = trackers[symbol]; if (t) enqueue(symbol, t.onNew15mBar(bar)); }

// ---- connect / retry loop --------------------------------------------------
function connectAndRun() {
  return new Promise(async (resolve) => {
    let wsUrl;
    try { wsUrl = await getMarketFeedUrl(); }
    catch (e) { console.error('Could not get feed URL (expired/missing token?):', e.message); resolve({ reason: 'auth_failed' }); return; }

    console.log('Connecting to Upstox live feed...');
    const ws = new WebSocket(wsUrl, { followRedirects: true });
    let settled = false;
    const finish = (reason) => { if (!settled) { settled = true; resolve({ reason }); } };

    ws.on('open', () => {
      console.log('Connected. Subscribing to', Object.keys(symbolMap).length, 'halal Nifty stocks...');
      setTimeout(() => {
        ws.send(Buffer.from(JSON.stringify({ guid: 'pdh-pdl-live', method: 'sub',
          data: { mode: 'full', instrumentKeys: Object.values(symbolMap) } })));
        console.log('Subscription sent.');
      }, 1000);
    });

    ws.on('message', (data) => {
      let decoded;
      try { decoded = decodeProtobuf(data); } catch (e) { console.warn('Protobuf decode error:', e.message); return; }
      if (!decoded || !decoded.feeds) return;
      for (const [instrumentKey, feed] of Object.entries(decoded.feeds)) {
        const symbol = keyToSymbol[instrumentKey];
        if (!symbol) continue;
        const candles = extractOneMinCandles(feed);
        for (const c of candles) { agg5[symbol] && agg5[symbol].push(c); agg15[symbol] && agg15[symbol].push(c); }
      }
    });

    ws.on('close', () => { console.log('Disconnected.'); finish('closed'); });
    ws.on('error', (err) => { console.error('WebSocket error:', err.message); finish('error'); });
    process.once('SIGTERM', () => { finalizeDay(ws); finish('sigterm'); });
    process.once('SIGINT', () => { finalizeDay(ws); finish('sigint'); });
  });
}

function finalizeDay(ws) {
  console.log('Finalizing day...');
  for (const symbol of Object.keys(agg5)) { agg5[symbol].flushRemaining(); agg15[symbol] && agg15[symbol].flushRemaining(); }
  for (const symbol of Object.keys(trackers)) enqueue(symbol, trackers[symbol].forceEndOfDay());
  try { ws.close(); } catch (_) { /* already closed */ }
}

async function main() {
  console.log(`Initializing PDH/PDL scanner... [config=${CONFIG_TAG}${MIN_R_PCT > 0 ? `, min-R=${MIN_R_PCT}%` : ', no min-R (v1)'}]`);
  await initProtobuf();
  await db.init();
  await prepDay();
  scheduleDailyPrep();

  let attempt = 0;
  for (;;) {
    const { reason } = await connectAndRun();
    if (reason === 'sigterm' || reason === 'sigint') { console.log('Shutting down (', reason, ').'); process.exit(0); }
    attempt++;
    const delayMs = Math.min(30000 * attempt, 300000);
    console.log(`Connection ended (${reason}). Retrying in ${delayMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
