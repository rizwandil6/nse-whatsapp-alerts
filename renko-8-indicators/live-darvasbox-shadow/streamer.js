'use strict';

/**
 * DarvasBox SHADOW-TRADE tick streamer -- one deliberate, already-vetted
 * combo (not a forward-test grid): 0.25% brick, flat 1% stop-loss off the
 * real entry (not brick-size-derived), BOTH directions (DarvasBox's
 * getEntry is symmetric -- LONG on a confirmed-box breakout above, SHORT
 * on a breakdown below; see strategies.js). Chosen from the stop-loss
 * sweep run 2026-07-27 across the real 21-holding portfolio: 0.25% brick /
 * 1% stop was the single best combined (LONG+SHORT) net P&L point in that
 * sweep.
 *
 * Built on the same tick-WebSocket architecture as
 * ../live/streamer.js (auth flow, protobuf decode, reconnect/backoff,
 * TickBarBuilder) -- copied fresh into this directory rather than required
 * cross-directory, since each strategy's live/ directory is its own
 * independently-deployed Railway service (see MarketDataFeedV3.proto's own
 * docstring in the sibling directories for why).
 *
 * THE key deliberate difference from ../live/streamer.js: brick-CONFIRMED
 * entries and exits (getEntry, getExit's TRAILING_BOX_STOP) are priced at
 * the live LTP at confirmation time, not the theoretical brick close --
 * built into DarvasLiveTracker itself (see darvas_tracker.js's 2026-07-27
 * fork docstring), not bolted on afterward. This directly reflects the
 * lesson from tonight's LTP-vs-brick-price analysis on the Renko N/K grid:
 * a brick's close can already be stale by the time it's confirmed and
 * dispatched, and measuring that gap after the fact (as the N/K grid did)
 * isn't the same as trading on it. The already-real-time stop mechanisms
 * (checkIntrabarStop, checkTickStop) are unchanged -- they already fill at
 * a real, specific stop price level, not a brick close.
 *
 * Requires UPSTOX_ACCESS_TOKEN, GITHUB_TOKEN, and (optionally)
 * TELEGRAM_BOT_TOKEN env vars.
 */

const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('path');

const { buildRenkoBricks } = require('./renko');
const { DarvasLiveTracker } = require('./darvas_tracker');
const { syncFromRemote, recordAndPush, isDuplicateEvent } = require('./trade_log');
const { TickBarBuilder } = require('./tick_bar_builder');
const { MARKET_OPEN_MIN, MARKET_CLOSE_MIN, istMinutesOfDay, istDateStr, nowIst, aggregateTo5Min } = require('./bar_aggregator');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = (process.env.DARVAS_TELEGRAM_CHAT_IDS || '5937539323,-5338709046').split(',');
const PAPER_ALERTS_ENABLED = process.env.DARVAS_TELEGRAM_ENABLED !== 'false';
const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const HISTORICAL_INTRADAY_BASE = 'https://api.upstox.com/v3/historical-candle/intraday';
const FLUSH_POLL_MS = 15 * 1000;
const BACKFILL_DELAY_MS = 150;

const BRICK_PCT = 0.0025; // 0.25%, deliberate -- see module docstring
const BRICK_LABEL = '0.25';
const STOP_PCT = 0.01; // flat 1%, deliberate -- see module docstring

const symbols = require('./symbols.json');
const keyToSymbol = {};
for (const [symbol, key] of Object.entries(symbols)) keyToSymbol[key] = symbol;

const tickBuilders = {}; // symbol -> TickBarBuilder
const oneMinBars = {};   // symbol -> today's closed 1-min bars, in-memory only
const trackers = {};     // symbol -> DarvasLiveTracker
for (const symbol of Object.keys(symbols)) {
  oneMinBars[symbol] = [];
  trackers[symbol] = new DarvasLiveTracker(symbol, STOP_PCT, () => {
    const b = tickBuilders[symbol];
    return b ? b.getLivePrice() : null;
  });
}
let currentDate = null;
let protobufRoot = null;
let lastGoodTickMs = null;

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

async function sendTelegramAlert(text) {
  const label = PAPER_ALERTS_ENABLED ? '[DARVAS-SHADOW]' : '[DARVAS-SHADOW-SUPPRESSED]';
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

function formatEntryAlert(e) {
  const arrow = e.direction === 'LONG' ? '↑' : '↓';
  const driftNote = e.livePriceAvailable && e.theoreticalEntry !== e.entry
    ? ` (brick close was ₹${e.theoreticalEntry.toFixed(2)})`
    : '';
  return `🌗 SHADOW TRADE — DarvasBox [0.25% brick, 1% SL] (paper, not a real order)\n${arrow} ${e.direction}: ${e.symbol}\nEntry (LTP): ₹${e.entry.toFixed(2)}${driftNote}\nStop: ₹${e.stop.toFixed(2)} (flat 1%)`;
}
function formatExitAlert(e) {
  const sign = e.pnlPct >= 0 ? '+' : '';
  const driftNote = e.livePriceAvailable && e.theoreticalExit != null && e.theoreticalExit !== e.exitPrice
    ? ` (brick close was ₹${e.theoreticalExit.toFixed(2)})`
    : '';
  return `🌗 SHADOW TRADE — DarvasBox [0.25% brick, 1% SL] position closed (paper)\n${e.symbol} ${e.direction}\nEntry: ₹${e.entry.toFixed(2)} → Exit (LTP): ₹${e.exitPrice.toFixed(2)}${driftNote}\nReason: ${e.action}\nP&L: ${sign}${e.pnlPct.toFixed(2)}% (gross, no costs applied)`;
}

function dispatchEvent(symbol, e) {
  e.brickPct = BRICK_LABEL;
  if (isDuplicateEvent(e)) {
    console.log(`Skipping duplicate ${e.type} alert for ${symbol} -- already recorded (replay/backfill).`);
    return;
  }
  const { dateStr } = nowIst();
  if (e.type === 'ENTRY') {
    sendTelegramAlert(formatEntryAlert(e)).catch((err) => console.error('sendTelegramAlert threw:', err.message));
    recordAndPush(e, dateStr).catch((err) => console.error('recordAndPush threw:', err.message));
  } else if (e.type === 'EXIT') {
    sendTelegramAlert(formatExitAlert(e)).catch((err) => console.error('sendTelegramAlert threw:', err.message));
    recordAndPush(e, dateStr).catch((err) => console.error('recordAndPush threw:', err.message));
  }
}

function maybeResetForNewDay(nowMs) {
  const dateStr = istDateStr(nowMs);
  if (dateStr === currentDate) return;
  currentDate = dateStr;
  for (const symbol of Object.keys(symbols)) {
    oneMinBars[symbol] = [];
    trackers[symbol].resetForNewDay();
  }
  console.log(`New trading day: ${dateStr}. Tracker + in-memory 1-min bar buffers reset.`);
}

function ingestOneMinBar(symbol, bar, silent) {
  const minutesOfDay = istMinutesOfDay(bar.timestampMs);
  if (minutesOfDay < MARKET_OPEN_MIN || minutesOfDay > MARKET_CLOSE_MIN + 15) return;

  oneMinBars[symbol].push(bar);
  const fiveMin = aggregateTo5Min(oneMinBars[symbol]);
  if (fiveMin.length === 0) return;

  const bricks = buildRenkoBricks(fiveMin, BRICK_PCT);
  const tracker = trackers[symbol];
  const events = tracker.processBricks(bricks);
  const intrabarEvent = tracker.checkIntrabarStop(fiveMin);
  if (intrabarEvent) events.push(intrabarEvent);
  if (minutesOfDay >= MARKET_CLOSE_MIN) {
    const eodEvent = tracker.forceEodClose(bricks);
    if (eodEvent) events.push(eodEvent);
  }
  if (!silent) for (const e of events) dispatchEvent(symbol, e);
}

async function startupBackfillIfNeeded() {
  const { minutesOfDay } = nowIst();
  if (minutesOfDay < MARKET_OPEN_MIN) {
    console.log('Started before market open — no backfill needed, building the session live from here.');
    return;
  }
  const entries = Object.entries(symbols);
  console.log(`Started mid-session (minute ${minutesOfDay}) — backfilling today so far for ${entries.length} symbols...`);
  let recovered = 0, failed = 0;
  for (const [symbol, instrumentKey] of entries) {
    try {
      const candles = await fetchTodaysOneMinCandles(instrumentKey);
      for (const bar of candles) ingestOneMinBar(symbol, bar, true);
      if (candles.length > 0) recovered++;
    } catch (e) {
      failed++;
      console.warn(`  Startup backfill failed for ${symbol}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
  }
  console.log(`Startup backfill complete: ${recovered}/${entries.length} recovered, ${failed} failed (will build live from here for those).`);
}

async function backfillGapIfNeeded() {
  if (lastGoodTickMs == null) return;
  console.log('Reconnected after a gap — backfilling any missed bars (will alert normally for anything found)...');
  for (const [symbol, instrumentKey] of Object.entries(symbols)) {
    try {
      const candles = await fetchTodaysOneMinCandles(instrumentKey);
      const lastKnownMs = oneMinBars[symbol].length ? oneMinBars[symbol][oneMinBars[symbol].length - 1].timestampMs : -Infinity;
      const gapBars = candles.filter((c) => c.timestampMs > lastKnownMs);
      for (const bar of gapBars) ingestOneMinBar(symbol, bar, false);
    } catch (e) {
      console.warn(`  Gap backfill failed for ${symbol}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
  }
}

function checkEodSweep() {
  const { minutesOfDay } = nowIst();
  if (minutesOfDay < MARKET_CLOSE_MIN) return;
  for (const symbol of Object.keys(symbols)) {
    const fiveMin = aggregateTo5Min(oneMinBars[symbol]);
    if (fiveMin.length === 0) continue;
    const bricks = buildRenkoBricks(fiveMin, BRICK_PCT);
    const eodEvent = trackers[symbol].forceEodClose(bricks);
    if (eodEvent) dispatchEvent(symbol, eodEvent);
  }
}

function scheduleBarFlush() {
  setInterval(() => {
    const now = Date.now();
    for (const [symbol, builder] of Object.entries(tickBuilders)) {
      const bar = builder.flushIfStale(now);
      if (bar) ingestOneMinBar(symbol, bar, false);
    }
    checkEodSweep();
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
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        resolve({ reason });
      };

      ws.on('open', () => {
        console.log('Connected. Subscribing to', Object.keys(symbols).length, 'symbols...');
        setTimeout(() => {
          const instrumentKeys = Object.values(symbols);
          ws.send(Buffer.from(JSON.stringify({
            guid: `darvasbox-shadow-${Date.now()}`,
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
            if (!symbol) continue;
            const tick = extractTick(feed);
            if (!tick) continue;
            lastGoodTickMs = Date.now();

            const tickEvent = trackers[symbol].checkTickStop(tick);
            if (tickEvent) dispatchEvent(symbol, tickEvent);

            const closedBar = getOrCreateTickBuilder(symbol).onTick(tick);
            if (closedBar) ingestOneMinBar(symbol, closedBar, false);
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

async function main() {
  if (!UPSTOX_TOKEN) {
    console.error('UPSTOX_ACCESS_TOKEN not set — cannot start.');
    process.exit(1);
  }
  console.log(`DarvasBox SHADOW streamer starting. ${Object.keys(symbols).length} symbols, 0.25% brick, flat 1% stop, LTP-confirmed entries/exits.`);
  console.log(`Telegram alerts: ${PAPER_ALERTS_ENABLED ? 'ENABLED (paper-labeled)' : 'SUPPRESSED (logging only)'}`);

  await initProtobuf();
  await syncFromRemote();
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
