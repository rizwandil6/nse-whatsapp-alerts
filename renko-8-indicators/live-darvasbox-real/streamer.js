'use strict';

/**
 * DarvasBox REAL-MONEY tick streamer. Entry: Renko box breakout on 1-min-
 * bar-built bricks (0.25%, identical to live-darvasbox-shadow). Exit:
 * 9/20 EMA crossover on 5-min bars (identical math to live-darvasbox-
 * shadow), plus a catastrophic-stop backstop and a daily max-loss circuit
 * breaker that the paper tracker doesn't have -- see live_tracker.js and
 * risk_manager.js docstrings.
 *
 * LIVE_TRADING_ENABLED defaults to false and is the master kill switch --
 * even though this is a dedicated directory/service (never at risk of
 * being confused with the paper shadow-trader), a config mistake could
 * still deploy this without meaning to enable real orders, so the code
 * itself must default to inert. With it false, this process still runs
 * the full tick-WebSocket/brick/EMA pipeline and logs exactly what it
 * WOULD do, but never calls OrderClient at all.
 *
 * Requires UPSTOX_ACCESS_TOKEN, GITHUB_TOKEN, and (optionally)
 * TELEGRAM_BOT_TOKEN env vars, same as live-darvasbox-shadow. Additionally
 * requires LIVE_TRADING_ENABLED=true to place any real order.
 */

const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('path');

const { buildRenkoBricks } = require('./renko');
const { OrderClient } = require('./order_client');
const { RiskManager } = require('./risk_manager');
const { LiveDarvasTracker } = require('./live_tracker');
const { syncFromRemote, recordAndPush, isDuplicateEvent, getTodaysExits } = require('./trade_log');
const { TickBarBuilder } = require('./tick_bar_builder');
const { MARKET_OPEN_MIN, MARKET_CLOSE_MIN, istMinutesOfDay, istDateStr, nowIst, aggregateTo5Min, aggregateTo5MinMultiDay } = require('./bar_aggregator');

const UPSTOX_TOKEN_ENV = 'UPSTOX_ACCESS_TOKEN'; // read fresh each call, not cached -- token is refreshed daily
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = (process.env.DARVAS_TELEGRAM_CHAT_IDS || '5937539323,-5338709046').split(',');
const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const HISTORICAL_INTRADAY_BASE = 'https://api.upstox.com/v3/historical-candle/intraday';
const HISTORICAL_RANGE_BASE = 'https://api.upstox.com/v3/historical-candle'; // date-ranged (non-today) candles, for EMA warm-up
const FLUSH_POLL_MS = 15 * 1000;
const BACKFILL_DELAY_MS = 150;
const EMA_WARMUP_LOOKBACK_DAYS = 12; // see live-darvasbox-shadow/bar_aggregator.js's aggregateTo5MinMultiDay docstring -- same fix, ported here for consistency

const BRICK_PCT = 0.0025; // 0.25%, same as live-darvasbox-shadow
const CATASTROPHIC_STOP_PCT = 0.03; // 3%, wide backstop -- see live_tracker.js
const DAILY_MAX_LOSS_RS = Number(process.env.DAILY_MAX_LOSS_RS || 5000); // must be set deliberately for real capital, this default is a placeholder
const LIVE_TRADING_ENABLED = process.env.LIVE_TRADING_ENABLED === 'true'; // master kill switch, default OFF

// Real held qty per symbol -- same figures as live-darvasbox-shadow's QUANTITIES.
// This is the sizing rule for REAL orders too, which is a deliberate choice to
// review before enabling: it reuses real-holdings size, not a capital-per-trade
// or risk-per-trade formula. See live_tracker.js's constructor docstring.
const QUANTITIES = {
  CONCOR: 23, GAIL: 75, HATHWAY: 58, HINDCOPPER: 42, JKIL: 25, JSWINFRA: 66,
  MANINDS: 71, MHRIL: 52, NHPC: 350, OLAELEC: 3059, ORIENTELEC: 226, RAILTEL: 14,
  RVNL: 961, SUZLON: 615, WAAREEENER: 56, ADSL: 52, 'ARE&M': 15, NCC: 61,
  STERTOOLS: 28, TEXRAIL: 76, TITAGARH: 16,
};

const symbols = require('./symbols.json');
const keyToSymbol = {};
for (const [symbol, key] of Object.entries(symbols)) keyToSymbol[key] = symbol;

const orderClient = new OrderClient(() => process.env[UPSTOX_TOKEN_ENV]);
const riskManager = new RiskManager(DAILY_MAX_LOSS_RS);

const tickBuilders = {}; // symbol -> TickBarBuilder
const oneMinBars = {};   // symbol -> today's closed 1-min bars, in-memory only
const trackers = {};     // symbol -> LiveDarvasTracker
// symbol -> 5-min bars from BEFORE today, fetched once/day -- see
// live-darvasbox-shadow/streamer.js's identical field for the full reasoning.
const historicalBars5 = {};
for (const [symbol, instrumentKey] of Object.entries(symbols)) {
  const qty = QUANTITIES[symbol];
  if (!qty) { console.warn(`No QUANTITIES entry for ${symbol} -- skipping (would not know what size to order).`); continue; }
  oneMinBars[symbol] = [];
  historicalBars5[symbol] = [];
  trackers[symbol] = new LiveDarvasTracker(symbol, instrumentKey, qty, orderClient, riskManager, { catastrophicStopPct: CATASTROPHIC_STOP_PCT });
}
let currentDate = null;
let protobufRoot = null;
let lastGoodTickMs = null;
let circuitBreakerAlertSent = false;

let dayStats = { trades: 0, wins: 0, totalPnlPct: 0, totalPnlRs: 0 };
let eodSummarySent = false;

function getOrCreateTickBuilder(symbol) {
  if (!tickBuilders[symbol]) tickBuilders[symbol] = new TickBarBuilder();
  return tickBuilders[symbol];
}

const FETCH_TIMEOUT_MS = 10 * 1000;
function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function getMarketFeedUrl() {
  const res = await fetchWithTimeout(AUTHORIZE_URL, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${process.env[UPSTOX_TOKEN_ENV]}` },
  });
  if (!res.ok) throw new Error(`Authorize failed: HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  return body.data.authorizedRedirectUri || body.data.authorized_redirect_uri;
}

async function initProtobuf() {
  protobufRoot = await protobuf.load(path.join(__dirname, 'MarketDataFeedV3.proto'));
}

function decodeProtobuf(buffer) {
  const FeedResponse = protobufRoot.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
  const message = FeedResponse.decode(buffer);
  return FeedResponse.toObject(message, { longs: Number, enums: String, defaults: true });
}

function extractTick(feed) {
  const fullFeed = feed.fullFeed;
  const marketFF = fullFeed && fullFeed.marketFF;
  if (!marketFF || !marketFF.ltpc) return null;
  return { ltp: marketFF.ltpc.ltp, lttMs: Number(marketFF.ltpc.ltt) };
}

async function fetchTodaysOneMinCandles(instrumentKey) {
  const url = `${HISTORICAL_INTRADAY_BASE}/${encodeURIComponent(instrumentKey)}/minutes/1`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${process.env[UPSTOX_TOKEN_ENV]}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`Upstox status: ${body.status}`);
  return (body.data.candles || [])
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Past EMA_WARMUP_LOOKBACK_DAYS calendar days of 1-min candles, aggregated to multi-day-safe 5-min bars -- see live-darvasbox-shadow/streamer.js's identical function. */
async function fetchHistorical5MinBars(instrumentKey) {
  const to = isoDaysAgo(1);
  const from = isoDaysAgo(EMA_WARMUP_LOOKBACK_DAYS);
  const url = `${HISTORICAL_RANGE_BASE}/${encodeURIComponent(instrumentKey)}/minutes/1/${to}/${from}`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${process.env[UPSTOX_TOKEN_ENV]}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`Upstox status: ${body.status}`);
  const candles = (body.data.candles || [])
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
  return aggregateTo5MinMultiDay(candles);
}

async function loadEmaWarmup() {
  console.log(`Fetching ${EMA_WARMUP_LOOKBACK_DAYS} calendar days of history for continuous EMA warm-up (${Object.keys(trackers).length} symbols)...`);
  let ok = 0, failed = 0;
  for (const symbol of Object.keys(trackers)) {
    try {
      historicalBars5[symbol] = await fetchHistorical5MinBars(symbols[symbol]);
      ok++;
    } catch (e) {
      console.warn(`  EMA warm-up fetch failed for ${symbol}: ${e.message} -- falling back to cold-start for this symbol today.`);
      historicalBars5[symbol] = [];
      failed++;
    }
    await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
  }
  console.log(`EMA warm-up history loaded: ${ok}/${Object.keys(trackers).length} symbols (${failed} failed).`);
}

async function sendTelegramAlert(text) {
  const label = LIVE_TRADING_ENABLED ? '[DARVAS-REAL]' : '[DARVAS-REAL-DISABLED]';
  console.log(label, text.replace(/\n/g, ' | '));
  if (!TELEGRAM_TOKEN) return;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) console.warn(`  Telegram send failed for chat ${chatId}: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`  Telegram send error for chat ${chatId}: ${e.message}`);
    }
  }
}

function formatEntryAlert(e) {
  const arrow = e.direction === 'LONG' ? '↑' : '↓';
  return `🔴 REAL TRADE — DarvasBox [0.25% brick, 9/20 EMA exit]\n${arrow} ${e.direction}: ${e.symbol}\nQty: ${e.qty} @₹${e.entry.toFixed(2)} (real fill)\nOrder: ${e.orderId}`;
}
function formatExitAlert(e, runningTotal) {
  const sign = e.pnlPct >= 0 ? '+' : '';
  return `🔴 REAL TRADE — DarvasBox position closed\n${e.symbol} ${e.direction}\nEntry: ₹${e.entry.toFixed(2)} → Exit: ₹${e.exitPrice.toFixed(2)} (real fill)\nReason: ${e.action}\nP&L: ${sign}${e.pnlPct.toFixed(2)}% / ${e.pnlRs >= 0 ? '+' : '−'}₹${Math.abs(e.pnlRs).toFixed(0)}\n\n📊 Day so far: ${runningTotal.trades} trades, ${runningTotal.wins} wins, total ${runningTotal.totalPnlPct >= 0 ? '+' : ''}${runningTotal.totalPnlPct.toFixed(2)}% / ${runningTotal.totalPnlRs >= 0 ? '+' : '−'}₹${Math.abs(runningTotal.totalPnlRs).toFixed(0)}`;
}
function formatOrderProblemAlert(e) {
  return `🚨 ORDER PROBLEM — ${e.symbol} ${e.phase} (${e.reason || e.direction || ''})\n${e.type}${e.status ? ` status=${e.status}` : ''}${e.error ? `\n${e.error}` : ''}\nVERIFY MANUALLY ON UPSTOX.`;
}
function formatCircuitBreakerAlert(reason) {
  return `🚨 CIRCUIT BREAKER TRIPPED\n${reason}\nAll open positions are being squared off. No new entries for the rest of today.`;
}

function updateDayStats(e) {
  dayStats.trades += 1;
  if (e.pnlPct > 0) dayStats.wins += 1;
  dayStats.totalPnlPct += e.pnlPct;
  dayStats.totalPnlRs += e.pnlRs;
}

function dispatchEvent(symbol, e) {
  if (e.type === 'ORDER_ERROR' || e.type === 'ORDER_UNCONFIRMED') {
    sendTelegramAlert(formatOrderProblemAlert(e)).catch((err) => console.error('sendTelegramAlert threw:', err.message));
    return;
  }
  if (isDuplicateEvent(e)) {
    console.log(`Skipping duplicate ${e.type} alert for ${symbol} -- already recorded (replay/backfill).`);
    return;
  }
  const { dateStr } = nowIst();
  if (e.type === 'ENTRY') {
    sendTelegramAlert(formatEntryAlert(e)).catch((err) => console.error('sendTelegramAlert threw:', err.message));
    recordAndPush(e, dateStr).catch((err) => console.error('recordAndPush threw:', err.message));
  } else if (e.type === 'EXIT') {
    updateDayStats(e);
    sendTelegramAlert(formatExitAlert(e, dayStats)).catch((err) => console.error('sendTelegramAlert threw:', err.message));
    recordAndPush(e, dateStr).catch((err) => console.error('recordAndPush threw:', err.message));
  }
}

/** Sweeps every open position closed the instant the daily circuit breaker trips -- separate from the per-symbol exit checks, since this fires regardless of EMA/catastrophic state. */
async function checkCircuitBreaker() {
  if (!riskManager.tripped || circuitBreakerAlertSent) return;
  circuitBreakerAlertSent = true;
  await sendTelegramAlert(formatCircuitBreakerAlert(riskManager.trippedReason)).catch((err) => console.error('sendTelegramAlert threw:', err.message));
  for (const [symbol, tracker] of Object.entries(trackers)) {
    if (!tracker.position) continue;
    try {
      const event = await tracker.forceCircuitBreakerSquareOff();
      if (event) dispatchEvent(symbol, event);
    } catch (e) {
      console.error(`Circuit-breaker square-off failed for ${symbol}:`, e.message);
    }
  }
}

function maybeResetForNewDay(nowMs) {
  const dateStr = istDateStr(nowMs);
  if (dateStr === currentDate) return;
  currentDate = dateStr;
  dayStats = { trades: 0, wins: 0, totalPnlPct: 0, totalPnlRs: 0 };
  eodSummarySent = false;
  circuitBreakerAlertSent = false;
  riskManager.resetForNewDay();
  for (const symbol of Object.keys(trackers)) {
    oneMinBars[symbol] = [];
    trackers[symbol].resetForNewDay();
  }
  console.log(`New trading day: ${dateStr}. Trackers + risk manager + in-memory bar buffers + day stats reset.`);
  loadEmaWarmup().catch((e) => console.error('EMA warm-up reload for the new day failed:', e.message));
}

function maybeSendEodSummary() {
  if (eodSummarySent) return;
  const { minutesOfDay } = nowIst();
  if (minutesOfDay < MARKET_CLOSE_MIN) return;
  const anyOpen = Object.values(trackers).some((t) => t.position != null);
  if (anyOpen) return;
  eodSummarySent = true;
  const s = dayStats;
  const winRate = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0.0';
  const text = `🔴 EOD SUMMARY — DarvasBox REAL trade, ${currentDate}\nTrades: ${s.trades} | Wins: ${s.wins} (${winRate}%)\nTotal P&L: ${s.totalPnlPct >= 0 ? '+' : ''}${s.totalPnlPct.toFixed(2)}% / ${s.totalPnlRs >= 0 ? '+' : '−'}₹${Math.abs(s.totalPnlRs).toFixed(0)}`;
  sendTelegramAlert(text).catch((err) => console.error('sendTelegramAlert threw:', err.message));
}

/** Same cadence as live-darvasbox-shadow: processBricks (entries) -> checkEmaCrossExit (5-min) -> checkCatastrophicStop (1-min) -> EOD sweep. */
async function ingestOneMinBar(symbol, bar, silent) {
  const minutesOfDay = istMinutesOfDay(bar.timestampMs);
  if (minutesOfDay < MARKET_OPEN_MIN || minutesOfDay > MARKET_CLOSE_MIN + 15) return;

  oneMinBars[symbol].push(bar);
  const bars = oneMinBars[symbol];
  const bricks = buildRenkoBricks(bars, BRICK_PCT);
  const tracker = trackers[symbol];
  if (!tracker) return;

  const events = [];
  if (LIVE_TRADING_ENABLED) {
    events.push(...await tracker.processBricks(bricks));
    const bars5 = historicalBars5[symbol].concat(aggregateTo5Min(bars));
    const emaCrossEvent = await tracker.checkEmaCrossExit(bars5);
    if (emaCrossEvent) events.push(emaCrossEvent);
    const catastrophicEvent = await tracker.checkCatastrophicStop(bars);
    if (catastrophicEvent) events.push(catastrophicEvent);
    if (minutesOfDay >= MARKET_CLOSE_MIN && tracker.position) {
      const eodEvent = await tracker.forceEodClose();
      if (eodEvent) events.push(eodEvent);
    }
  } else {
    // Disabled: still run entry/exit detection so logs show what WOULD happen, but never call OrderClient.
    tracker.processedBrickCount = bricks.length;
    tracker.processedBar5Count = historicalBars5[symbol].length + aggregateTo5Min(bars).length;
    tracker.processedBarCount = bars.length;
  }

  if (!silent) {
    for (const e of events) dispatchEvent(symbol, e);
    if (minutesOfDay >= MARKET_CLOSE_MIN) {
      await checkCircuitBreaker();
      maybeSendEodSummary();
    }
  }
}

async function startupBackfillIfNeeded() {
  const { minutesOfDay } = nowIst();
  if (minutesOfDay < MARKET_OPEN_MIN) {
    console.log('Started before market open — no backfill needed, building the session live from here.');
    return;
  }
  const entries = Object.entries(symbols).filter(([symbol]) => trackers[symbol]);
  console.log(`Started mid-session (minute ${minutesOfDay}) — backfilling today so far for ${entries.length} symbols...`);
  let recovered = 0, failed = 0;
  for (const [symbol, instrumentKey] of entries) {
    try {
      const candles = await fetchTodaysOneMinCandles(instrumentKey);
      for (const bar of candles) await ingestOneMinBar(symbol, bar, true);
      if (candles.length > 0) recovered++;
    } catch (e) {
      failed++;
      console.warn(`  Startup backfill failed for ${symbol}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
  }
  console.log(`Startup backfill complete: ${recovered}/${entries.length} recovered, ${failed} failed (will build live from here for those).`);
}

async function logStartupPositionCheck() {
  if (!LIVE_TRADING_ENABLED) return;
  try {
    const positions = await orderClient.getPositions();
    const open = positions.filter((p) => Number(p.quantity) !== 0);
    if (open.length > 0) {
      console.warn(`⚠️  Upstox reports ${open.length} REAL open position(s) at startup -- this tracker starts with NO in-memory position state for any symbol. Verify these are expected (e.g. this is a restart) before assuming a clean slate:`);
      for (const p of open) console.warn(`   ${p.trading_symbol || p.instrument_token}: qty=${p.quantity}`);
    } else {
      console.log('Upstox reports no open positions at startup — clean slate confirmed.');
    }
  } catch (e) {
    console.error('Startup position check failed (getPositions is unverified against the real API — see order_client.js):', e.message);
  }
}

async function backfillGapIfNeeded() {
  if (lastGoodTickMs == null) return;
  console.log('Reconnected after a gap — backfilling any missed bars...');
  for (const [symbol, instrumentKey] of Object.entries(symbols)) {
    if (!trackers[symbol]) continue;
    try {
      const candles = await fetchTodaysOneMinCandles(instrumentKey);
      const lastKnownMs = oneMinBars[symbol].length ? oneMinBars[symbol][oneMinBars[symbol].length - 1].timestampMs : -Infinity;
      const gapBars = candles.filter((c) => c.timestampMs > lastKnownMs);
      for (const bar of gapBars) await ingestOneMinBar(symbol, bar, false);
    } catch (e) {
      console.warn(`  Gap backfill failed for ${symbol}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
  }
}

async function checkEodSweep() {
  const { minutesOfDay } = nowIst();
  if (minutesOfDay < MARKET_CLOSE_MIN) return;
  if (LIVE_TRADING_ENABLED) {
    for (const [symbol, tracker] of Object.entries(trackers)) {
      if (!tracker.position) continue;
      const eodEvent = await tracker.forceEodClose();
      if (eodEvent) dispatchEvent(symbol, eodEvent);
    }
  }
  await checkCircuitBreaker();
  maybeSendEodSummary();
}

function scheduleBarFlush() {
  setInterval(async () => {
    const now = Date.now();
    for (const [symbol, builder] of Object.entries(tickBuilders)) {
      const bar = builder.flushIfStale(now);
      if (bar) await ingestOneMinBar(symbol, bar, false);
    }
    await checkEodSweep();
  }, FLUSH_POLL_MS);
}

function connectAndRun() {
  return new Promise((resolve) => {
    (async () => {
      let wsUrl;
      try {
        wsUrl = await getMarketFeedUrl();
      } catch (e) {
        console.error('Could not get market feed URL (likely an expired/missing token):', e.message);
        resolve({ reason: 'auth_failed' });
        return;
      }

      console.log('Connecting to Upstox live feed...');
      const ws = new WebSocket(wsUrl, { followRedirects: true });

      let settled = false;
      const finish = (reason) => { if (!settled) { settled = true; resolve({ reason }); } };

      ws.on('open', () => {
        console.log('Connected. Subscribing to', Object.keys(trackers).length, 'symbols...');
        setTimeout(() => {
          const instrumentKeys = Object.entries(symbols).filter(([s]) => trackers[s]).map(([, key]) => key);
          ws.send(Buffer.from(JSON.stringify({
            guid: `darvasbox-real-${Date.now()}`,
            method: 'sub',
            data: { mode: 'full', instrumentKeys },
          })));
          console.log('Subscription sent.');
        }, 1000);
      });

      ws.on('message', (data) => {
        let decoded;
        try {
          decoded = decodeProtobuf(data);
        } catch (e) {
          console.warn('Protobuf decode error:', e.message);
          return;
        }
        if (!decoded || !decoded.feeds) return;
        maybeResetForNewDay(Date.now());

        for (const [instrumentKey, feed] of Object.entries(decoded.feeds)) {
          try {
            const symbol = keyToSymbol[instrumentKey];
            if (!symbol || !trackers[symbol]) continue;
            const tick = extractTick(feed);
            if (!tick) continue;
            lastGoodTickMs = Date.now();

            const closedBar = getOrCreateTickBuilder(symbol).onTick(tick);
            if (closedBar) ingestOneMinBar(symbol, closedBar, false).catch((e) => console.error(`ingestOneMinBar(${symbol}) threw:`, e.message));
          } catch (e) {
            console.error(`Tick processing threw for ${instrumentKey}:`, e.message, e.stack);
          }
        }
      });

      ws.on('close', () => { console.log('Disconnected from feed.'); finish('closed'); });
      ws.on('error', (err) => { console.error('WebSocket error:', err.message); finish('error'); });

      process.once('SIGTERM', () => { console.log('SIGTERM: closing feed connection...'); ws.close(); setTimeout(() => finish('sigterm'), 500); });
      process.once('SIGINT', () => { console.log('SIGINT: closing feed connection...'); ws.close(); setTimeout(() => finish('sigint'), 500); });
    })();
  });
}

async function main() {
  if (!process.env[UPSTOX_TOKEN_ENV]) {
    console.error('UPSTOX_ACCESS_TOKEN not set — cannot start.');
    process.exit(1);
  }
  console.log(`DarvasBox REAL streamer starting. ${Object.keys(trackers).length} symbols, 0.25% brick, 9/20 EMA cross (5-min) exit, ${CATASTROPHIC_STOP_PCT * 100}% catastrophic stop, ₹${DAILY_MAX_LOSS_RS} daily loss limit.`);
  console.log(`LIVE_TRADING_ENABLED=${LIVE_TRADING_ENABLED} -- ${LIVE_TRADING_ENABLED ? 'REAL ORDERS WILL BE PLACED.' : 'inert: detection runs, no orders will be placed.'}`);
  console.log(`Telegram alerts: ${TELEGRAM_TOKEN ? 'ENABLED' : 'SUPPRESSED (logging only)'}`);

  await initProtobuf();
  await syncFromRemote();
  await logStartupPositionCheck();

  const { dateStr: todayStr } = nowIst();
  currentDate = todayStr;
  for (const e of getTodaysExits(todayStr, istDateStr)) updateDayStats(e);
  if (dayStats.trades > 0) {
    console.log(`Restored today's running P&L from the persisted log: ${dayStats.trades} trades, ${dayStats.wins} wins, total ${dayStats.totalPnlPct.toFixed(2)}% so far.`);
  }

  await loadEmaWarmup();
  await startupBackfillIfNeeded();
  scheduleBarFlush();

  let attempt = 0;
  let isFirstConnect = true;
  for (;;) {
    const { reason } = await connectAndRun();
    if (reason === 'sigterm' || reason === 'sigint') {
      console.log('Shutting down (', reason, ').');
      process.exit(0);
    }
    if (!isFirstConnect) {
      await backfillGapIfNeeded().catch((e) => console.error('Gap backfill threw:', e.message));
    }
    isFirstConnect = false;
    attempt++;
    const delayMs = Math.min(30000 * attempt, 300000);
    console.log(`Connection ended (${reason}). Retrying in ${delayMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
