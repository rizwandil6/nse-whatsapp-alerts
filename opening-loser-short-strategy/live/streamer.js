'use strict';

/**
 * Live "Opening Loser Short" scalp scanner — F&O-eligible ∩ halal universe
 * (137 stocks, symbols.json). Connects to Upstox's official V3 market-data
 * WebSocket in lightweight `ltpc` mode (ltp, last-trade-time, and prior
 * day's close all arrive directly on every tick — no separate historical
 * fetch needed for the previous close).
 *
 * Rules (as backtested in ../scan_opening_loser_short.js, "as is" — this
 * config backtested net negative; running live anyway per explicit ask,
 * alert-only, to forward-test with real data):
 *   - ~09:15:30 IST: snapshot every symbol's (ltp - cp) / cp * 100. No band —
 *     pick the single most-negative mover across the whole universe.
 *   - Entry: SHORT at that ltp.
 *   - No stop-loss.
 *   - Circuit/liquidity-freeze exit: if the picked symbol's last-trade-time
 *     (ltt) stops advancing for CIRCUIT_FREEZE_MS while the trade is open,
 *     exit immediately at the last known ltp. This is a proxy (Upstox's
 *     feed doesn't expose an explicit circuit flag) — see backtest file's
 *     LIMITATIONS comment for the same caveat.
 *   - Exit: cover at 09:30:00 IST if neither of the above already closed it.
 *   - One trade per day.
 *
 * Alert-only. NO orders are ever placed.
 *
 * Requires: UPSTOX_ACCESS_TOKEN (daily-refreshed, same as the other bots),
 *           TELEGRAM_BOT_TOKEN, and DATABASE_URL (or .secrets/pg_url.txt).
 *
 * Strategy write-up: wiki/concepts/opening-loser-short-scalp.md (vault).
 */

const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('path');

const { DB } = require('./db');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046']; // personal + group (same as other bots)
const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const IST_OFFSET_MS = 5.5 * 3600000;

const ENTRY_MIN_OF_DAY = 9 * 60 + 15;         // 09:15
const ENTRY_SEC_OFFSET = 30;                   // + 30s -> 09:15:30
const EXIT_MIN_OF_DAY = 9 * 60 + 30;           // 09:30:00
const CIRCUIT_FREEZE_MS = 60000;               // no new trade for 60s -> treat as frozen

if (!UPSTOX_TOKEN) { console.error('FATAL: UPSTOX_ACCESS_TOKEN not set.'); process.exit(1); }
if (!TELEGRAM_TOKEN) console.warn('WARNING: TELEGRAM_BOT_TOKEN not set. Alerts logged, not sent.');

const symbolMap = require('./symbols.json');
const keyToSymbol = {};
for (const [symbol, key] of Object.entries(symbolMap)) keyToSymbol[key] = symbol;

const db = new DB();

let protobufRoot = null;
// symbol -> { ltp, ltt, cp, lastSeenAtMs }
const state = {};
for (const symbol of Object.keys(symbolMap)) state[symbol] = { ltp: null, ltt: null, cp: null, lastSeenAtMs: null };

let lastPreppedDate = null;
let entryDoneToday = false;
let exitDoneToday = false;
let position = null; // { symbol, signalId, entry, entryTs, tradeDate }

function istDate(ms) { return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10); }
function istTimeStr(ms) { return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 19); }
function istMinOfDay(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function istSecOfMinute(ms) { return new Date(ms + IST_OFFSET_MS).getUTCSeconds(); }
function todayIst() { return istDate(Date.now()); }

function resetDay() {
  entryDoneToday = false;
  exitDoneToday = false;
  position = null;
  for (const symbol of Object.keys(state)) state[symbol] = { ltp: null, ltt: null, cp: null, lastSeenAtMs: null };
  lastPreppedDate = todayIst();
  console.log(`Reset for trading day ${lastPreppedDate}.`);
}

// ---- Upstox feed plumbing ----------------------------------------------
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

// ---- Telegram ------------------------------------------------------------
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

async function emit(alertType, symbol, text, signalId) {
  const ok = await sendTelegram(text);
  await db.insertAlert({ signalId, symbol, alertType, chatId: TELEGRAM_CHAT_IDS.join(','), text, sentOk: ok });
}

const f = (x) => (x == null ? '—' : Number(x).toFixed(2));

function fmtEntry(e) {
  return [
    `🔴 SHORT ENTRY — ${e.symbol}`,
    `LTP ${f(e.entry)}  |  Prev close ${f(e.prevClose)}  |  Open move ${e.pctChange >= 0 ? '+' : ''}${e.pctChange.toFixed(2)}%`,
    `Top loser across ${Object.keys(symbolMap).length}-stock F&O∩halal universe, no band, no stop-loss.`,
    `Cover at 09:30 IST unless circuit/freeze exit fires first.`,
    `${istTimeStr(e.entryTs)} IST · alert-only, no order placed.`,
  ].join('\n');
}
function fmtExit(e) {
  const icon = e.pnlPct > 0 ? '✅' : e.pnlPct < 0 ? '🛑' : '⏹️';
  const resultWord = e.pnlPct > 0 ? 'WIN' : e.pnlPct < 0 ? 'LOSS' : 'FLAT';
  return [
    `${icon} ${e.symbol} covered — ${e.exitReason} @ ${f(e.exitPx)}`,
    `Entry ${f(e.entry)}  →  Exit ${f(e.exitPx)}`,
    `P&L: ${e.pnlPct >= 0 ? '+' : ''}${e.pnlPct.toFixed(2)}%  (${resultWord})`,
    `${istTimeStr(e.exitTs)} IST.`,
  ].join('\n');
}

// ---- core logic ------------------------------------------------------------
async function tryEnterPosition(nowMs) {
  if (entryDoneToday) return;
  const candidates = [];
  for (const [symbol, s] of Object.entries(state)) {
    if (s.ltp == null || !s.cp) continue;
    const pctChange = ((s.ltp - s.cp) / s.cp) * 100;
    candidates.push({ symbol, ltp: s.ltp, cp: s.cp, pctChange });
  }
  entryDoneToday = true; // only ever try once, at/after the trigger second, regardless of outcome

  if (!candidates.length) {
    console.log('No ticks received by entry window — no trade today.');
    return;
  }
  candidates.sort((a, b) => a.pctChange - b.pctChange);
  const pick = candidates[0];
  if (pick.pctChange >= 0) {
    console.log('Top mover is not a loser (whole universe green?) — no trade today.');
    return;
  }

  const tradeDate = istDate(nowMs);
  const signalId = await db.insertSignal({
    symbol: pick.symbol, tradeDate, prevClose: pick.cp, openPctChange: pick.pctChange,
    entryTs: nowMs, entryPx: pick.ltp,
  });
  position = { symbol: pick.symbol, signalId, entry: pick.ltp, entryTs: nowMs, tradeDate };
  await emit('ENTRY', pick.symbol, fmtEntry({ symbol: pick.symbol, entry: pick.ltp, prevClose: pick.cp, pctChange: pick.pctChange, entryTs: nowMs }), signalId);
}

async function closePosition(nowMs, exitPx, exitReason) {
  if (!position || exitDoneToday) return;
  exitDoneToday = true;
  const pnlPct = ((position.entry - exitPx) / position.entry) * 100; // SHORT
  const result = pnlPct > 0 ? 'WIN' : pnlPct < 0 ? 'LOSS' : 'FLAT';
  await db.closeOutcome(position.signalId, { exitTs: nowMs, exitPx, exitReason, pnlPct, result });
  await emit('EXIT', position.symbol, fmtExit({ symbol: position.symbol, entry: position.entry, exitPx, exitReason, exitTs: nowMs, pnlPct }), position.signalId);
}

/** Runs every second: drives entry trigger, circuit-freeze check, and 09:30 exit. */
function scheduleTicker() {
  setInterval(async () => {
    const now = Date.now();
    const d = istDate(now);
    if (d !== lastPreppedDate) { resetDay(); return; }

    const minOfDay = istMinOfDay(now);
    const secOfMin = istSecOfMinute(now);

    // Entry trigger: 09:15:30, once.
    if (!entryDoneToday && minOfDay === ENTRY_MIN_OF_DAY && secOfMin >= ENTRY_SEC_OFFSET) {
      await tryEnterPosition(now).catch((e) => console.error('tryEnterPosition failed:', e.message));
    }

    // Circuit/freeze check while a position is open.
    if (position && !exitDoneToday) {
      const s = state[position.symbol];
      if (s && s.lastSeenAtMs != null && now - s.lastSeenAtMs > CIRCUIT_FREEZE_MS) {
        await closePosition(now, s.ltp, 'CIRCUIT').catch((e) => console.error('closePosition (circuit) failed:', e.message));
      }
    }

    // Hard time exit: 09:30:00.
    if (position && !exitDoneToday && minOfDay >= EXIT_MIN_OF_DAY) {
      const s = state[position.symbol];
      const exitPx = s && s.ltp != null ? s.ltp : position.entry;
      await closePosition(now, exitPx, 'TIME_930').catch((e) => console.error('closePosition (time) failed:', e.message));
    }
  }, 1000);
}

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
      console.log('Connected. Subscribing (ltpc mode) to', Object.keys(symbolMap).length, 'stocks...');
      setTimeout(() => {
        ws.send(Buffer.from(JSON.stringify({ guid: 'opening-loser-short-live', method: 'sub',
          data: { mode: 'ltpc', instrumentKeys: Object.values(symbolMap) } })));
        console.log('Subscription sent.');
      }, 1000);
    });

    ws.on('message', (data) => {
      let decoded;
      try { decoded = decodeProtobuf(data); } catch (e) { console.warn('Protobuf decode error:', e.message); return; }
      if (!decoded || !decoded.feeds) return;
      const now = Date.now();
      for (const [instrumentKey, feed] of Object.entries(decoded.feeds)) {
        const symbol = keyToSymbol[instrumentKey];
        if (!symbol || !feed.ltpc) continue;
        const s = state[symbol];
        s.ltp = feed.ltpc.ltp;
        s.ltt = Number(feed.ltpc.ltt) || s.ltt;
        s.cp = feed.ltpc.cp || s.cp;
        s.lastSeenAtMs = now;
      }
    });

    ws.on('close', (code, reason) => { console.log('Disconnected. code=', code, 'reason=', reason ? reason.toString() : ''); finish('closed'); });
    ws.on('error', (err) => { console.error('WebSocket error:', err.message || err.code || err.toString(), err.stack); finish('error'); });
    process.once('SIGTERM', () => { finish('sigterm'); });
    process.once('SIGINT', () => { finish('sigint'); });
  });
}

async function main() {
  console.log('Initializing Opening Loser Short scanner...');
  await initProtobuf();
  await db.init();
  resetDay();
  scheduleTicker();

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
