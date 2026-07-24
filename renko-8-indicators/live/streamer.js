'use strict';

/**
 * DarvasBox PAPER-ALERT tick streamer -- Phase 1 of moving off the 5-min
 * REST poller (poller.js, kept in place as a manual fallback/comparison
 * tool during validation). Still paper-only, no orders placed.
 *
 * Connects to Upstox's official V3 market-data WebSocket feed, same
 * pattern as the ORB live streamer (intraday-movers-strategy/live/
 * streamer.js) -- auth flow, protobuf decode, reconnect/backoff, and
 * TickBarBuilder are all reused verbatim (tick_bar_builder.js and
 * MarketDataFeedV3.proto are byte-identical copies of ORB's, since
 * TickBarBuilder is already symbol-agnostic and each strategy's live/
 * directory is its own independently-deployed Railway service, not a
 * shared build context -- a cross-directory require would risk failing
 * at deploy time).
 *
 * Two stop checks now run ahead of the original brick-based one:
 *   1. checkTickStop -- every raw tick's LTP, the instant it arrives.
 *   2. checkIntrabarStop -- every real 5-min bar's low/high (kept as a
 *      cheap secondary net; see darvas_tracker.js for both).
 * Entry/box-confirmation logic is UNCHANGED and still runs on 5-min
 * Renko bricks (processBricks, renko.js, strategies.js) -- that's a
 * structural signal, not a latency-sensitive one. The only thing that
 * changes for entries is where the underlying 1-min bars come from:
 * built here from live ticks via TickBarBuilder instead of fetched via
 * Upstox's REST intraday endpoint every 5 minutes.
 *
 * Requires UPSTOX_ACCESS_TOKEN and (optionally) TELEGRAM_BOT_TOKEN env
 * vars, same as poller.js.
 *
 * Brick-size forward test (2026-07-24, one week): runs BRICK_PCTS (default
 * 0.15/0.20/0.25/0.30%) in full parallel, per symbol -- 21 symbols x 4 sizes
 * = 84 independent DarvasLiveTracker lanes, each with its own position/stop
 * state, sharing only the underlying tick stream and 1-min bars (bar
 * construction doesn't depend on brick size; Renko construction and every
 * downstream check does). Every alert/log entry is tagged with its brick
 * size (`e.brickPct`) so the week's results can be split apart and compared
 * to pick one going forward -- see trade_log.js's eventKey for why brickPct
 * had to be added to the dedup key too, not just the alert text.
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
const FLUSH_POLL_MS = 15 * 1000; // force-close forming bars whose minute elapsed with no new tick (EOD, illiquid gaps)
const BACKFILL_DELAY_MS = 150; // pacing between REST calls across symbols, avoids Upstox rate limits

/**
 * Brick-size forward test (started 2026-07-24, one week): 4 brick sizes run
 * in full parallel per symbol, sharing the same tick/1-min-bar feed but each
 * building its OWN Renko bricks and running its own independent DarvasBox
 * entry/exit/stop logic -- so each brick size has its own real, independently
 * timed trades, not a re-derivation of one "true" set. Every alert is tagged
 * with its brick size so the week's results can be told apart and compared
 * to pick one going forward. Override via DARVAS_BRICK_PCTS (comma-separated
 * percents) if the set needs to change; defaults to the test's 4 sizes.
 */
const BRICK_PCTS = (process.env.DARVAS_BRICK_PCTS || '0.15,0.20,0.25,0.30')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((label) => ({ label, pct: parseFloat(label) / 100 }));

const symbols = require('./symbols.json');
const keyToSymbol = {};
for (const [symbol, key] of Object.entries(symbols)) keyToSymbol[key] = symbol;

const trackers = {}; // symbol -> { [brickLabel]: DarvasLiveTracker }
const tickBuilders = {}; // symbol -> TickBarBuilder (ONE per symbol, shared across all brick sizes -- bar construction is brick-size-independent)
const oneMinBars = {}; // symbol -> today's closed 1-min bars, in-memory only, shared across brick sizes
for (const symbol of Object.keys(symbols)) {
  trackers[symbol] = {};
  for (const { label } of BRICK_PCTS) trackers[symbol][label] = new DarvasLiveTracker(symbol);
  oneMinBars[symbol] = [];
}
let currentDate = null;
let protobufRoot = null;
let lastGoodTickMs = null;

function getOrCreateTickBuilder(symbol) {
  if (!tickBuilders[symbol]) tickBuilders[symbol] = new TickBarBuilder();
  return tickBuilders[symbol];
}

const FETCH_TIMEOUT_MS = 10 * 1000;

/** Upstox REST calls have no built-in timeout -- a single stalled request would otherwise
 *  block startup (backfill loops over 21 symbols sequentially) or a reconnect forever. */
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

/** Only marketFF (equities) carries LTPC/vtt/tbq/tsq -- indexFF (indices) is unused by this watchlist, returns null. */
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
  const label = PAPER_ALERTS_ENABLED ? '[DARVAS-PAPER]' : '[DARVAS-PAPER-SUPPRESSED]';
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
  return `📝 PAPER ALERT — DarvasBox [${e.brickPct}% brick] (unvalidated, not a trade signal)\n${arrow} ${e.direction}: ${e.symbol}\nEntry: ₹${e.entry.toFixed(2)}\nStop: ₹${e.stop.toFixed(2)}\nNo target — trailing box stop`;
}
function formatExitAlert(e) {
  const sign = e.pnlPct >= 0 ? '+' : '';
  return `📝 PAPER ALERT — DarvasBox [${e.brickPct}% brick] position closed (unvalidated)\n${e.symbol} ${e.direction}\nEntry: ₹${e.entry.toFixed(2)} → Exit: ₹${e.exitPrice.toFixed(2)}\nReason: ${e.action}\nP&L: ${sign}${e.pnlPct.toFixed(2)}% (gross, no costs applied)`;
}

function dispatchEvent(symbol, e, brickLabel) {
  // Tag every event with which of the 4 forward-test brick sizes produced it
  // -- required so the week's trade log can be split apart and compared at
  // the end, and so isDuplicateEvent() (which keys on symbol/direction/
  // prices/timestamps) can't conflate two different brick sizes' events
  // that happen to land on the exact same entry/exit price and timestamp.
  e.brickPct = brickLabel;
  // Gap-backfill (backfillGapIfNeeded) deliberately re-processes bars that may
  // already have been ingested once before the reconnect -- and, same as a
  // full poller restart, brick reconstruction is deterministic, so a replay
  // can re-derive an event already recorded. Skip both the alert and the log
  // write for anything already in the log, not just the log write.
  if (isDuplicateEvent(e)) {
    console.log(`Skipping duplicate ${e.type} alert for ${symbol} [${brickLabel}%] -- already recorded (replay/backfill).`);
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
    for (const { label } of BRICK_PCTS) trackers[symbol][label].resetForNewDay();
  }
  console.log(`New trading day: ${dateStr}. Trackers (all ${BRICK_PCTS.length} brick sizes) + in-memory 1-min bar buffers reset.`);
}

/**
 * Feeds one closed 1-min bar through the 5-min Renko/entry pipeline, once
 * per brick size in the forward test -- UNCHANGED per-brick-size logic from
 * poller.js's pollSymbol, just (a) triggered per closed 1-min bar instead of
 * every 5 minutes, and (b) run 4 times, once per BRICK_PCTS entry, each with
 * its own independent tracker/position/stop state. `silent` suppresses
 * alert/log-push dispatch (used by startup backfill, where a trade that
 * fully happened before this process started isn't actionable now);
 * gap-backfill after a mid-day reconnect does NOT suppress -- those alerts
 * fire normally, since closing exactly that kind of detection gap is the
 * point of this project.
 */
function ingestOneMinBar(symbol, bar, silent) {
  const minutesOfDay = istMinutesOfDay(bar.timestampMs);
  if (minutesOfDay < MARKET_OPEN_MIN || minutesOfDay > MARKET_CLOSE_MIN + 15) return;

  oneMinBars[symbol].push(bar);
  const fiveMin = aggregateTo5Min(oneMinBars[symbol]); // shared across brick sizes -- 5-min aggregation doesn't depend on brick size
  if (fiveMin.length === 0) return;

  for (const { label, pct } of BRICK_PCTS) {
    const bricks = buildRenkoBricks(fiveMin, pct);
    const tracker = trackers[symbol][label];
    const events = tracker.processBricks(bricks);
    const intrabarEvent = tracker.checkIntrabarStop(fiveMin);
    if (intrabarEvent) events.push(intrabarEvent);
    if (minutesOfDay >= MARKET_CLOSE_MIN) {
      const eodEvent = tracker.forceEodClose(bricks);
      if (eodEvent) events.push(eodEvent);
    }
    if (!silent) for (const e of events) dispatchEvent(symbol, e, label);
  }
}

/**
 * One-time startup recovery for a mid-day deploy/restart -- mirrors ORB's
 * backfillTodaySessionIfNeeded(). Replays today's candles-so-far through
 * the normal pipeline to rebuild oneMinBars/tracker state, but DISCARDS
 * any resulting events: a trade that fully entered and exited before this
 * process started isn't actionable, and alerting on it now would be
 * confusing/stale.
 */
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
      for (const bar of candles) ingestOneMinBar(symbol, bar, true); // events discarded -- see docstring
      if (candles.length > 0) recovered++;
    } catch (e) {
      failed++;
      console.warn(`  Startup backfill failed for ${symbol}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
  }
  console.log(`Startup backfill complete: ${recovered}/${entries.length} recovered, ${failed} failed (will build live from here for those).`);
}

/**
 * Mid-day reconnect-gap recovery -- deliberately the OPPOSITE of startup
 * backfill's discard behavior. Re-fetches today's candles, filters to only
 * bars newer than the last one already ingested for that symbol, and feeds
 * them through the pipeline NORMALLY (alerts/trade-log entries fire for
 * anything the outage caused to be missed). This means an alert can arrive
 * a few minutes late during a bad connection, but never silently vanishes
 * -- closing exactly that kind of gap is the reason this streamer exists.
 */
async function backfillGapIfNeeded() {
  if (lastGoodTickMs == null) return; // never connected successfully yet -- nothing to fill
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

/** Force-closes any forming 1-min bar whose minute has fully elapsed with no new tick (illiquid symbols, EOD). */
function scheduleBarFlush() {
  setInterval(() => {
    const now = Date.now();
    for (const [symbol, builder] of Object.entries(tickBuilders)) {
      const bar = builder.flushIfStale(now);
      if (bar) ingestOneMinBar(symbol, bar, false);
    }
  }, FLUSH_POLL_MS);
}

/** Resolves (never rejects) when the connection ends -- a dropped socket or bad token must never crash the process. */
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
            guid: `darvasbox-live-${Date.now()}`,
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
          const symbol = keyToSymbol[instrumentKey];
          if (!symbol) continue;
          const tick = extractTick(feed);
          if (!tick) continue;
          lastGoodTickMs = Date.now();

          for (const { label } of BRICK_PCTS) {
            const tickEvent = trackers[symbol][label].checkTickStop(tick);
            if (tickEvent) dispatchEvent(symbol, tickEvent, label);
          }

          const closedBar = getOrCreateTickBuilder(symbol).onTick(tick);
          if (closedBar) ingestOneMinBar(symbol, closedBar, false);
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

      // Send a real WS close handshake before exiting, not just process.exit() --
      // otherwise Upstox's backend never sees this session end (its socket is just
      // yanked), which can leave it considering the feed still "attached" to this
      // access token across a redeploy. A brief delay lets the close frame actually
      // reach the wire before the process dies.
      process.once('SIGTERM', () => { console.log('SIGTERM: closing feed connection...'); ws.close(); setTimeout(() => finish('sigterm'), 500); });
      process.once('SIGINT', () => { console.log('SIGINT: closing feed connection...'); ws.close(); setTimeout(() => finish('sigint'), 500); });
    })();
  });
}

/** Outer retry loop, linear backoff capped at 5 min -- same resilience pattern as ORB's live streamer. */
async function main() {
  if (!UPSTOX_TOKEN) {
    console.error('UPSTOX_ACCESS_TOKEN not set — cannot start.');
    process.exit(1);
  }
  console.log(`DarvasBox TICK streamer starting. ${Object.keys(symbols).length} symbols, brick sizes: ${BRICK_PCTS.map((b) => b.label + '%').join(', ')} (forward test, started 2026-07-24).`);
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
