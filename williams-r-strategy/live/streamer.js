'use strict';

/**
 * Williams %R mean-reversion (paper) tick streamer -- ONE deliberate,
 * backtested combo (not a forward-test grid): period=14, oversold=-90,
 * overbought=-10, confirm_n=2, NO stop-loss, on 5-minute candles. See
 * williams_r_tracker.js's module docstring for the exact entry/exit state
 * machine (ported from renko-python-backtest/williams_r_backtest.py's
 * run_backtest()) and renko-python-backtest/williams_r_backtest.py for the
 * combo grid this was picked from (2026-07-30 backtest on the real
 * 21-holding portfolio: 13 trades, 84.6% win rate, +₹1,492 that day).
 *
 * KEY ARCHITECTURAL DIFFERENCE FROM EVERY OTHER live/ SERVICE IN THIS
 * REPO: no daily reset, no forced EOD square-off. The backtest itself
 * doesn't day-scope trades (a position can span multiple days), so this
 * doesn't either -- a losing trade rides until the opposite %R threshold,
 * however long that takes, even across weekends. That means, unlike
 * DarvasBox (rebuilds its tracker fresh every morning) or RS-momentum
 * (pure daily batch, no live ticks at all), THIS service's open
 * position + in-progress watch-state must survive a restart -- see
 * tracked_state.js / git_state.js. oneMinBars per symbol is a single,
 * never-daily-reset growing array (periodically trimmed to a trailing
 * window purely to bound memory, NOT on a day boundary), and bars5 is
 * recomputed fresh from it via aggregateTo5MinMultiDay on every new bar --
 * simpler and safer than DarvasBox's historical-prefix + today's-growing-
 * suffix split (that split was an optimization DarvasBox needed for its
 * OWN reasons; recomputing the whole (bounded, modest-sized) 5-min series
 * every 1-5 minutes is cheap enough here not to bother).
 *
 * Same tick-WebSocket architecture as the sibling live/ services (auth
 * flow, protobuf decode, reconnect/backoff, TickBarBuilder) -- copied
 * fresh into this directory rather than required cross-directory, since
 * each strategy's live/ directory is its own independently-deployed
 * Railway service.
 *
 * Entries/exits priced at live LTP when available (falls back to the
 * theoretical bar open/close otherwise) -- see williams_r_tracker.js.
 *
 * Requires UPSTOX_ACCESS_TOKEN, GITHUB_TOKEN, and (optionally)
 * TELEGRAM_BOT_TOKEN env vars.
 */

const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('path');

const { WilliamsRLiveTracker } = require('./williams_r_tracker');
const { syncFromRemote, commitAndPushState } = require('./git_state');
const { recordTrade, isDuplicateEvent } = require('./trade_log');
const { readTrackedState, writeTrackedState } = require('./tracked_state');
const { TickBarBuilder } = require('./tick_bar_builder');
const { MARKET_OPEN_MIN, MARKET_CLOSE_MIN, istMinutesOfDay, istDateStr, nowIst, aggregateTo5MinMultiDay } = require('./bar_aggregator');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = (process.env.WILLIAMS_R_TELEGRAM_CHAT_IDS || '5937539323,-5338709046').split(',');
const PAPER_ALERTS_ENABLED = process.env.WILLIAMS_R_TELEGRAM_ENABLED !== 'false';
const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const HISTORICAL_INTRADAY_BASE = 'https://api.upstox.com/v3/historical-candle/intraday';
const HISTORICAL_RANGE_BASE = 'https://api.upstox.com/v3/historical-candle';
const FLUSH_POLL_MS = 15 * 1000;
const BACKFILL_DELAY_MS = 150;
const LOOKBACK_DAYS = 20; // comfortably warms up period=14 across weekends/holidays -- see williams_r_backtest.py's own 15-day choice
const TRIM_KEEP_DAYS = 45; // periodic memory bound, unrelated to any day-boundary reset -- see module docstring

const STRATEGY_LABEL = "%R(14) osld=-90/obt=-10, confirm=2, 5-min, no stop-loss";

const symbols = require('./symbols.json');
const keyToSymbol = {};
for (const [symbol, key] of Object.entries(symbols)) keyToSymbol[key] = symbol;

// Real held qty per symbol (renko-python-backtest/holdings.csv), so rupee
// P&L in alerts reflects your actual position size, not a flat notional.
const QUANTITIES = {
  CONCOR: 23, GAIL: 75, HATHWAY: 58, HINDCOPPER: 42, JKIL: 25, JSWINFRA: 66,
  MANINDS: 71, MHRIL: 52, NHPC: 350, OLAELEC: 3059, ORIENTELEC: 226, RAILTEL: 14,
  RVNL: 961, SUZLON: 615, WAAREEENER: 56, ADSL: 52, 'ARE&M': 15, NCC: 61,
  STERTOOLS: 28, TEXRAIL: 76, TITAGARH: 16,
};

const tickBuilders = {}; // symbol -> TickBarBuilder
const oneMinBars = {};   // symbol -> ALL confirmed 1-min bars, never daily-reset (trimmed periodically -- see module docstring)
const trackers = {};     // symbol -> WilliamsRLiveTracker

let protobufRoot = null;
let lastGoodTickMs = null;

const WS_STALE_TIMEOUT_MS = 90 * 1000;
const WATCHDOG_INTERVAL_MS = 30 * 1000;
let lastActivityMs = null;
let currentWs = null;

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
    headers: { Accept: 'application/json', Authorization: `Bearer ${UPSTOX_TOKEN}` },
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
  return {
    ltp: marketFF.ltpc.ltp,
    lttMs: Number(marketFF.ltpc.ltt),
    vtt: Number(marketFF.vtt || 0),
    tbq: marketFF.tbq,
    tsq: marketFF.tsq,
  };
}

async function fetchTodaysOneMinCandles(instrumentKey) {
  const url = `${HISTORICAL_INTRADAY_BASE}/${encodeURIComponent(instrumentKey)}/minutes/1`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${UPSTOX_TOKEN}`, Accept: 'application/json' } });
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

/** Past LOOKBACK_DAYS calendar days of 1-min candles (up to yesterday -- today comes from the intraday endpoint), used ONLY to seed oneMinBars at startup so %R has valid values immediately instead of a ~70-minute cold-start gap. */
async function fetchHistorical1MinBars(instrumentKey) {
  const to = isoDaysAgo(1);
  const from = isoDaysAgo(LOOKBACK_DAYS);
  const url = `${HISTORICAL_RANGE_BASE}/${encodeURIComponent(instrumentKey)}/minutes/1/${to}/${from}`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${UPSTOX_TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`Upstox status: ${body.status}`);
  return (body.data.candles || [])
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

/** Trims oneMinBars[symbol] to the trailing TRIM_KEEP_DAYS -- a periodic MEMORY bound only, unrelated to any day-boundary reset (there is none here). period=14 needs far less history than this. */
function trimOldBars(symbol) {
  const cutoffMs = Date.now() - TRIM_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const bars = oneMinBars[symbol];
  let firstKeepIdx = 0;
  while (firstKeepIdx < bars.length && bars[firstKeepIdx].timestampMs < cutoffMs) firstKeepIdx++;
  if (firstKeepIdx > 0) oneMinBars[symbol] = bars.slice(firstKeepIdx);
}

async function sendTelegramAlert(text) {
  const label = PAPER_ALERTS_ENABLED ? '[WILLIAMS-R]' : '[WILLIAMS-R-SUPPRESSED]';
  console.log(label, text.replace(/\n/g, ' | '));
  if (!PAPER_ALERTS_ENABLED || !TELEGRAM_TOKEN) return;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch (e) {
      console.error(`Telegram send failed for chat ${chatId}:`, e.message);
    }
  }
}

function fmtIst(ms) {
  return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatEntryAlert(e) {
  const arrow = e.direction === 'LONG' ? '↑' : '↓';
  const driftNote = e.livePriceAvailable && e.theoreticalEntry !== e.entry
    ? ` (bar open was ₹${e.theoreticalEntry.toFixed(2)})`
    : '';
  return `📶 WILLIAMS %R — [${STRATEGY_LABEL}] (paper, not a real order)\n${arrow} ${e.direction}: ${e.symbol}\nEntry (LTP): ₹${e.entry.toFixed(2)}${driftNote}\n${fmtIst(e.timestampMs)} IST`;
}

function formatExitAlert(e) {
  const sign = e.pnlPct >= 0 ? '+' : '';
  const qty = QUANTITIES[e.symbol];
  const pnlRs = qty != null ? (e.direction === 'LONG' ? (e.exitPrice - e.entry) * qty : (e.entry - e.exitPrice) * qty) : null;
  const rsNote = pnlRs != null ? ` / ${pnlRs >= 0 ? '+' : '−'}₹${Math.abs(pnlRs).toFixed(0)}` : '';
  const driftNote = e.livePriceAvailable && e.theoreticalExit != null && e.theoreticalExit !== e.exitPrice
    ? ` (bar close was ₹${e.theoreticalExit.toFixed(2)})`
    : '';
  const heldMs = e.exitTimestampMs - e.entryTimestampMs;
  const heldMin = Math.round(heldMs / 60000);
  return `📶 WILLIAMS %R — [${STRATEGY_LABEL}] position closed (paper)\n${e.symbol} ${e.direction}\nEntry: ₹${e.entry.toFixed(2)} → Exit (LTP): ₹${e.exitPrice.toFixed(2)}${driftNote}\nReason: ${e.action}\nP&L: ${sign}${e.pnlPct.toFixed(2)}%${rsNote}\nHeld: ${heldMin} min\n${fmtIst(e.exitTimestampMs)} IST`;
}

function dispatchEvents(symbol, events) {
  for (const e of events) {
    if (isDuplicateEvent(e)) {
      console.log(`Skipping duplicate ${e.type} alert for ${symbol} — already recorded (replay/backfill).`);
      continue;
    }
    if (e.type === 'ENTRY') {
      sendTelegramAlert(formatEntryAlert(e)).catch((err) => console.error('sendTelegramAlert threw:', err.message));
    } else {
      sendTelegramAlert(formatExitAlert(e)).catch((err) => console.error('sendTelegramAlert threw:', err.message));
    }
    recordTrade(e);
  }
}

/** Runs the tracker over the current oneMinBars[symbol] and dispatches any new events -- called on every new confirmed 1-min bar. */
function processSymbol(symbol) {
  trimOldBars(symbol);
  const bars5 = aggregateTo5MinMultiDay(oneMinBars[symbol]);
  const events = trackers[symbol].processBars(bars5);
  if (events.length > 0) dispatchEvents(symbol, events);
}

function ingestOneMinBar(symbol, bar) {
  const minutesOfDay = istMinutesOfDay(bar.timestampMs);
  if (minutesOfDay < MARKET_OPEN_MIN || minutesOfDay > MARKET_CLOSE_MIN + 15) return;
  oneMinBars[symbol].push(bar);
  processSymbol(symbol);
}

/**
 * First-ever run for a symbol (no persisted tracked_williams_r.json entry):
 * pre-seeds lastProcessedTimestampMs to the last bar strictly BEFORE today,
 * so the initial processBars() call below silently skips every historical
 * warm-up bar for event-generation purposes (they still feed %R's rolling
 * window) and starts genuinely watching/alerting from today's own bars
 * onward -- a brand-new strategy deploy has no real prior "watching" state
 * to preserve, so starting clean from deployment day is the correct
 * behavior, not a shortcut.
 */
function seedFreshTrackerCutoff(tracker, bars5) {
  const { dateStr: todayStr } = nowIst();
  let cutoffMs = null;
  for (const b of bars5) {
    if (istDateStr(b.timestampMs) < todayStr) cutoffMs = b.timestampMs;
    else break;
  }
  tracker.lastProcessedTimestampMs = cutoffMs;
}

async function startupLoadAndSeed() {
  const trackedState = readTrackedState();
  console.log(`Fetching ${LOOKBACK_DAYS} calendar days of history + today for ${Object.keys(symbols).length} symbols...`);
  let ok = 0, failed = 0;

  for (const symbol of Object.keys(symbols)) {
    tickBuilders[symbol] = new TickBarBuilder();
    const hadPersistedState = Object.prototype.hasOwnProperty.call(trackedState, symbol);
    trackers[symbol] = WilliamsRLiveTracker.fromJSON(symbol, () => {
      const b = tickBuilders[symbol];
      return b ? b.getLivePrice() : null;
    }, trackedState[symbol]);

    try {
      const historical = await fetchHistorical1MinBars(symbols[symbol]);
      const today = await fetchTodaysOneMinCandles(symbols[symbol]);
      const merged = [...historical, ...today]
        .filter((c, i, arr) => i === 0 || c.timestampMs !== arr[i - 1].timestampMs)
        .sort((a, b) => a.timestampMs - b.timestampMs);
      oneMinBars[symbol] = merged;
      ok++;
    } catch (e) {
      console.warn(`  ${symbol}: startup history fetch failed (${e.message}) -- starting cold, will build live from here.`);
      oneMinBars[symbol] = [];
      failed++;
    }

    if (!hadPersistedState) {
      const bars5 = aggregateTo5MinMultiDay(oneMinBars[symbol]);
      seedFreshTrackerCutoff(trackers[symbol], bars5);
    }

    await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
  }
  console.log(`History loaded: ${ok}/${Object.keys(symbols).length} symbols (${failed} failed, starting cold).`);

  // Process once now, right after loading -- either silently establishes each
  // fresh tracker's cutoff (no alerts, see seedFreshTrackerCutoff) or catches
  // up a genuine gap since the last run (alerts normally, matching every
  // other live/ service's reconnect-gap convention).
  for (const symbol of Object.keys(symbols)) {
    processSymbol(symbol);
  }
  persistTrackedState();
}

function persistTrackedState() {
  const state = {};
  for (const symbol of Object.keys(symbols)) {
    state[symbol] = trackers[symbol].toJSON();
  }
  writeTrackedState(state);
}

async function backfillGapIfNeeded() {
  if (lastGoodTickMs == null) return;
  console.log('Reconnected after a gap — backfilling any missed bars (will alert normally for anything found)...');
  for (const [symbol, instrumentKey] of Object.entries(symbols)) {
    try {
      const candles = await fetchTodaysOneMinCandles(instrumentKey);
      const lastKnownMs = oneMinBars[symbol].length ? oneMinBars[symbol][oneMinBars[symbol].length - 1].timestampMs : -Infinity;
      const gapBars = candles.filter((c) => c.timestampMs > lastKnownMs);
      for (const bar of gapBars) ingestOneMinBar(symbol, bar);
    } catch (e) {
      console.warn(`  Gap backfill failed for ${symbol}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
  }
  persistTrackedState();
  await commitAndPushState(nowIst().dateStr).catch((e) => console.error('State push after gap backfill failed:', e.message));
}

function scheduleBarFlush() {
  setInterval(async () => {
    const now = Date.now();
    let anyNew = false;
    for (const [symbol, builder] of Object.entries(tickBuilders)) {
      const bar = builder.flushIfStale(now);
      if (bar) {
        ingestOneMinBar(symbol, bar);
        anyNew = true;
      }
    }
    if (anyNew) {
      persistTrackedState();
      await commitAndPushState(nowIst().dateStr).catch((e) => console.error('Periodic state push failed:', e.message));
    }
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
      currentWs = ws;

      let settled = false;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        if (currentWs === ws) currentWs = null;
        resolve({ reason });
      };

      ws.on('open', () => {
        console.log('Connected. Subscribing to', Object.keys(symbols).length, 'symbols...');
        lastActivityMs = Date.now();
        setTimeout(() => {
          const instrumentKeys = Object.values(symbols);
          ws.send(Buffer.from(JSON.stringify({
            guid: `williams-r-live-${Date.now()}`,
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

        for (const [instrumentKey, feed] of Object.entries(decoded.feeds)) {
          try {
            const symbol = keyToSymbol[instrumentKey];
            if (!symbol) continue;
            const tick = extractTick(feed);
            if (!tick) continue;
            lastGoodTickMs = Date.now();
            lastActivityMs = lastGoodTickMs;

            const closedBar = getOrCreateTickBuilder(symbol).onTick(tick);
            if (closedBar) ingestOneMinBar(symbol, closedBar);
          } catch (e) {
            console.error(`Tick processing threw for ${instrumentKey}:`, e.message, e.stack);
          }
        }
      });

      ws.on('close', () => {
        console.log('Disconnected from feed.');
        finish('closed');
      });

      ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
        finish('error');
      });

      process.once('SIGTERM', () => { console.log('SIGTERM: closing feed connection...'); ws.close(); setTimeout(() => finish('sigterm'), 500); });
      process.once('SIGINT', () => { console.log('SIGINT: closing feed connection...'); ws.close(); setTimeout(() => finish('sigint'), 500); });
    })();
  });
}

/**
 * Same stale-connection watchdog as every other live/ service (real
 * incident, 2026-07-30, orb-live-streamer) -- forcibly terminates the
 * WebSocket if no tick/activity for WS_STALE_TIMEOUT_MS during market
 * hours, letting the existing reconnect loop take over.
 */
function startStaleConnectionWatchdog() {
  setInterval(() => {
    const { minutesOfDay } = nowIst();
    if (minutesOfDay < MARKET_OPEN_MIN || minutesOfDay > MARKET_CLOSE_MIN + 15) return;
    if (!currentWs || lastActivityMs == null) return;
    const staleMs = Date.now() - lastActivityMs;
    if (staleMs > WS_STALE_TIMEOUT_MS) {
      console.error(`Stale-connection watchdog: no tick/activity for ${Math.round(staleMs / 1000)}s -- terminating and forcing a reconnect.`);
      currentWs.terminate();
    }
  }, WATCHDOG_INTERVAL_MS);
}

async function main() {
  if (!UPSTOX_TOKEN) {
    console.error('UPSTOX_ACCESS_TOKEN not set — cannot start.');
    process.exit(1);
  }
  console.log(`Williams %R streamer starting. ${Object.keys(symbols).length} symbols, [${STRATEGY_LABEL}], LTP-confirmed entries/exits.`);
  console.log(`Telegram alerts: ${PAPER_ALERTS_ENABLED ? 'ENABLED (paper-labeled)' : 'SUPPRESSED (logging only)'}`);

  await initProtobuf();
  await syncFromRemote();
  await startupLoadAndSeed();
  await commitAndPushState(nowIst().dateStr).catch((e) => console.error('Initial state push failed:', e.message));

  scheduleBarFlush();
  startStaleConnectionWatchdog();

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
