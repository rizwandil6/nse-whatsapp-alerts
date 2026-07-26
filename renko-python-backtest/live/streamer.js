'use strict';

/**
 * PAPER-ALERT live forward test of the Python Renko backtest engine's
 * validated 36-combo grid (../renko.py, ../signals.py, ../backtest.py).
 * Tracks all 36 combos per symbol; Telegram alerts fire only for the
 * winning combo (combos.js::WINNING_COMBO_ID -- brick_pct=0.15%,
 * entry_confirm_n=1, sl_rejection_n=1). Paper-only, no orders placed.
 *
 * Upstox V3 WebSocket auth/connect/reconnect ported from the sibling
 * renko-8-indicators/live/streamer.js (DarvasBox) almost verbatim -- that
 * plumbing is symbol/strategy-agnostic. What's NEW here (not shared with
 * DarvasBox, because the strategy itself is fundamentally different):
 *
 *  - renko_engine.js: DYNAMIC brick sizing (recomputed every brick), not
 *    DarvasBox's fixed-from-first-candle sizing.
 *  - Continuous, never-reset brick/run state per (symbol, brick_pct) --
 *    DarvasBox resets to "just today" every trading day; this strategy's
 *    validated behavior depends on a multi-month continuous brick series,
 *    so it must not reset (see renko_engine.js's docstring).
 *  - five_min_aggregator.js: an INCREMENTAL 5-min bar closer (exactly one
 *    candle fed to Renko per completed bar), not DarvasBox's
 *    rebuild-the-whole-day-every-tick batch aggregation -- required once
 *    the Renko builder itself is incremental/stateful (see that file's
 *    docstring for why a stateless batch rebuild isn't safe here).
 *  - No price-level stop at all (combo_signal_engine.js) -- every exit is
 *    brick-confirmation-driven, so no checkTickStop/checkIntrabarStop
 *    equivalent is needed; ticks only feed the 1-min bar builder.
 *  - state_store.js: a cheap, debounced state checkpoint (O(1) per lane,
 *    see renko_engine.js) so a Railway restart doesn't have to re-seed
 *    months of history through 23 symbols x 4 brick sizes before the
 *    service is live again.
 *  - EOD square-off (checkEodSweep/scheduleBarFlush pattern reused from
 *    DarvasBox) is a NEW rule the original Python backtest never applied
 *    -- added here specifically to close the MIS-vs-multiday gap flagged
 *    during backtest validation.
 *
 * Requires UPSTOX_ACCESS_TOKEN, TELEGRAM_BOT_TOKEN, DARVAS_TELEGRAM_CHAT_IDS
 * (reusing the same Telegram bot/chat as DarvasBox, per explicit choice),
 * and GITHUB_TOKEN (trade log + state checkpoint persistence).
 */

const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('path');

const { DynamicRenkoBuilder } = require('./renko_engine');
const { ComboTracker } = require('./combo_signal_engine');
const { COMBOS, COMBOS_BY_BRICK_PCT, WINNING_COMBO_ID } = require('./combos');
const { costRupees } = require('./costs');
const { TickBarBuilder } = require('./tick_bar_builder');
const { FiveMinBarAggregator } = require('./five_min_aggregator');
const { MARKET_OPEN_MIN, MARKET_CLOSE_MIN, istMinutesOfDay, istDateStr, nowIst } = require('./bar_aggregator');
const { loadSeedCandles } = require('./seed_loader');
const { fillGap } = require('./historical_gap_fill');
const { syncFromRemote, recordAndPush, isDuplicateEvent } = require('./trade_log');
const stateStore = require('./state_store');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = (process.env.DARVAS_TELEGRAM_CHAT_IDS || '5937539323,-5338709046').split(',');
const PAPER_ALERTS_ENABLED = process.env.DARVAS_TELEGRAM_ENABLED !== 'false';
const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const FLUSH_POLL_MS = 15 * 1000;
const SEED_DELAY_MS = 150; // pacing between symbols' historical fetches, avoids Upstox rate limits
const FETCH_TIMEOUT_MS = 10 * 1000;

const symbols = require('./symbols.json'); // { symbol: instrumentKey }, 23 total
const holdings = require('./holdings.json'); // { symbol: qty }, 21 real holdings (subset of symbols)
const keyToSymbol = {};
for (const [symbol, key] of Object.entries(symbols)) keyToSymbol[key] = symbol;

const BRICK_PCTS = Object.keys(COMBOS_BY_BRICK_PCT).map(Number);

// Per-symbol state -- see module docstring for why builders/trackers are continuous (never reset).
const tickBuilders = {}; // symbol -> TickBarBuilder
const fiveMinAggs = {}; // symbol -> FiveMinBarAggregator
const renkoBuilders = {}; // symbol -> { [brickPct]: DynamicRenkoBuilder }
const comboTrackers = {}; // symbol -> { [comboId]: ComboTracker }
const lastCandleTimestampMs = {}; // symbol -> ms of the last 5-min candle fed to the builders (for gap-fill resume point)

for (const symbol of Object.keys(symbols)) {
  tickBuilders[symbol] = new TickBarBuilder();
  fiveMinAggs[symbol] = new FiveMinBarAggregator();
  renkoBuilders[symbol] = {};
  comboTrackers[symbol] = {};
  for (const brickPct of BRICK_PCTS) renkoBuilders[symbol][brickPct] = new DynamicRenkoBuilder(brickPct);
  for (const c of COMBOS) comboTrackers[symbol][c.comboId] = new ComboTracker(c.comboId, c.entryConfirmN, c.slRejectionN);
  lastCandleTimestampMs[symbol] = null;
}

let protobufRoot = null;
let lastGoodTickMs = null;

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

async function sendTelegramAlert(text) {
  const label = PAPER_ALERTS_ENABLED ? '[RENKO-LIVE-PAPER]' : '[RENKO-LIVE-PAPER-SUPPRESSED]';
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

function comboLabel(comboId) {
  const c = COMBOS.find((x) => x.comboId === comboId);
  return `#${comboId} (${c.brickPct}% brick, N=${c.entryConfirmN}, K=${c.slRejectionN})`;
}

function formatEntryAlert(symbol, e) {
  const arrow = e.direction === 'LONG' ? '↑' : '↓';
  return `📈 RENKO LIVE — combo ${comboLabel(e.comboId)} (validated winner, paper only)\n${arrow} ${e.direction}: ${symbol}\nEntry: ₹${e.entry.toFixed(2)}\nNo fixed stop — exit is a confirmed brick reversal or rejection-SL`;
}

function formatExitAlert(symbol, e, qty) {
  const sign = e.pnlPct >= 0 ? '+' : '';
  let costLine = '';
  if (qty != null) {
    const cost = costRupees(e.entry, e.exitPrice, qty, e.direction);
    const grossRs = (e.direction === 'LONG' ? e.exitPrice - e.entry : e.entry - e.exitPrice) * qty;
    const netRs = grossRs - cost;
    costLine = `\nP&L ₹: ${netRs >= 0 ? '+' : ''}${netRs.toFixed(0)} net (gross ${grossRs >= 0 ? '+' : ''}${grossRs.toFixed(0)}, cost ₹${cost.toFixed(0)}, qty ${qty})`;
  }
  return `📉 RENKO LIVE — combo ${comboLabel(e.comboId)} position closed (paper only)\n${symbol} ${e.direction}\nEntry: ₹${e.entry.toFixed(2)} → Exit: ₹${e.exitPrice.toFixed(2)}\nReason: ${e.action}\nP&L %: ${sign}${e.pnlPct.toFixed(2)}%${costLine}`;
}

function dispatchEvent(symbol, e) {
  e.symbol = symbol;
  // Renko/combo state is deterministic, so a restart-triggered replay (checkpoint
  // miss, gap-fill overlap) can re-derive an event already recorded -- skip both
  // the alert and the log write for anything already logged, not just the write.
  if (isDuplicateEvent(e)) {
    console.log(`Skipping duplicate ${e.type} for ${symbol} combo ${e.comboId} -- already recorded (replay/restart).`);
    return;
  }
  const { dateStr } = nowIst();
  const qty = holdings[symbol];
  if (e.type === 'ENTRY') {
    if (e.comboId === WINNING_COMBO_ID) {
      sendTelegramAlert(formatEntryAlert(symbol, e)).catch((err) => console.error('sendTelegramAlert threw:', err.message));
    }
    recordAndPush(e, dateStr).catch((err) => console.error('recordAndPush threw:', err.message));
  } else if (e.type === 'EXIT') {
    if (e.comboId === WINNING_COMBO_ID) {
      sendTelegramAlert(formatExitAlert(symbol, e, qty)).catch((err) => console.error('sendTelegramAlert threw:', err.message));
    }
    recordAndPush(e, dateStr).catch((err) => console.error('recordAndPush threw:', err.message));
  }
}

/** Feeds one completed 5-min bar's close into every brick_pct builder for this symbol, dispatching any resulting combo events. */
function processFiveMinBar(symbol, bar) {
  lastCandleTimestampMs[symbol] = bar.timestampMs;
  for (const brickPct of BRICK_PCTS) {
    const builder = renkoBuilders[symbol][brickPct];
    const newBricks = builder.pushCandleClose(bar.close, bar.timestampMs);
    for (const brick of newBricks) {
      for (const combo of COMBOS_BY_BRICK_PCT[brickPct]) {
        const event = comboTrackers[symbol][combo.comboId].onBrick(brick);
        if (event) dispatchEvent(symbol, event);
      }
    }
  }
}

/** Feeds a candle through the Renko builders ONLY -- no combo-tracker/event dispatch. Used purely to reconstruct correct brick/run state from history; positions always start flat (see module docstring / plan). */
function seedCandleSilently(symbol, candle) {
  lastCandleTimestampMs[symbol] = candle.timestampMs;
  for (const brickPct of BRICK_PCTS) {
    renkoBuilders[symbol][brickPct].pushCandleClose(candle.close, candle.timestampMs);
  }
}

/**
 * Confirmed live bug (2026-07-26): Upstox's WS feed sends a stale snapshot
 * tick per instrument immediately on subscribe -- tagged with that
 * symbol's actual LAST REAL TRADE time (e.g. Friday 15:40 IST), which is
 * NOT "now". A time-of-day-only guard (is 15:40 between 09:15 and 15:45?)
 * happily lets a stale FRIDAY tick through as if it were live data,
 * because it only checks the clock, never the calendar date -- this fired
 * real Telegram alerts off days-old data while the market was closed.
 * Fixed by also requiring the bar's IST calendar date to match today's.
 */
function isLiveMarketBar(timestampMs) {
  const minutesOfDay = istMinutesOfDay(timestampMs);
  if (minutesOfDay < MARKET_OPEN_MIN || minutesOfDay > MARKET_CLOSE_MIN + 15) return false;
  return istDateStr(timestampMs) === istDateStr(Date.now());
}

function ingestOneMinBar(symbol, bar) {
  if (!isLiveMarketBar(bar.timestampMs)) return;
  const completed = fiveMinAggs[symbol].onOneMinBar(bar);
  if (completed) processFiveMinBar(symbol, completed);
}

function restoreFromCheckpoint(symbol, snapshot) {
  if (!snapshot) return false;
  for (const brickPct of BRICK_PCTS) {
    if (snapshot.builders && snapshot.builders[brickPct]) {
      renkoBuilders[symbol][brickPct] = DynamicRenkoBuilder.fromJSON(brickPct, snapshot.builders[brickPct]);
    }
  }
  for (const c of COMBOS) {
    if (snapshot.trackers && snapshot.trackers[c.comboId]) {
      comboTrackers[symbol][c.comboId] = ComboTracker.fromJSON(c.comboId, c.entryConfirmN, c.slRejectionN, snapshot.trackers[c.comboId]);
    }
  }
  lastCandleTimestampMs[symbol] = snapshot.lastCandleTimestampMs || null;
  return true;
}

function buildCheckpointSnapshot() {
  const state = {};
  for (const symbol of Object.keys(symbols)) {
    const builders = {};
    for (const brickPct of BRICK_PCTS) builders[brickPct] = renkoBuilders[symbol][brickPct].toJSON();
    const trackers = {};
    for (const c of COMBOS) trackers[c.comboId] = comboTrackers[symbol][c.comboId].toJSON();
    state[symbol] = { builders, trackers, lastCandleTimestampMs: lastCandleTimestampMs[symbol] };
  }
  return state;
}

/**
 * One-time startup: restore from checkpoint if available (fast path), else
 * seed from seed_data/{symbol}.csv (21 real holdings only -- IRCON/TRITURBINE
 * have no history and simply start fresh, per the plan), then always
 * gap-fill from the last known point (checkpoint or seed) to now. Every
 * candle here goes through seedCandleSilently -- builders only, no combo
 * events -- positions always start flat on cold start (see module docstring).
 */
async function seedAllSymbols() {
  const checkpoint = await stateStore.loadCheckpoint();
  const checkpointState = checkpoint ? checkpoint.state : null;

  for (const [symbol, instrumentKey] of Object.entries(symbols)) {
    try {
      let restored = false;
      if (checkpointState && checkpointState[symbol]) {
        restored = restoreFromCheckpoint(symbol, checkpointState[symbol]);
      }

      if (!restored) {
        const seedCandles = loadSeedCandles(symbol); // [] if no seed_data/{symbol}.csv (IRCON, TRITURBINE)
        for (const c of seedCandles) seedCandleSilently(symbol, c);
        if (seedCandles.length === 0) {
          console.log(`${symbol}: no seed history -- starting fresh from live data (never backtested/validated).`);
        }
      }

      if (UPSTOX_TOKEN) {
        const lastMs = lastCandleTimestampMs[symbol] != null ? lastCandleTimestampMs[symbol] : Date.now() - 24 * 60 * 60 * 1000;
        const gapCandles = await fillGap(UPSTOX_TOKEN, instrumentKey, lastMs);
        for (const c of gapCandles) seedCandleSilently(symbol, c);
        if (gapCandles.length) console.log(`${symbol}: gap-filled ${gapCandles.length} candles up to now (${restored ? 'since checkpoint' : 'since seed'}).`);
      }
    } catch (e) {
      console.warn(`  Seeding failed for ${symbol}: ${e.message} -- will build state live from here.`);
    }
    await new Promise((r) => setTimeout(r, SEED_DELAY_MS));
  }
  console.log('Startup seeding complete for all symbols.');
}

/** Wall-clock-driven EOD sweep -- force-closes any open position even if no new bar arrives right at close (mirrors DarvasBox's checkEodSweep). Only closes positions; never touches brick/run state, which must keep flowing unbroken into the next day. */
function checkEodSweep() {
  const { minutesOfDay } = nowIst();
  if (minutesOfDay < MARKET_CLOSE_MIN) return;
  for (const symbol of Object.keys(symbols)) {
    for (const brickPct of BRICK_PCTS) {
      const builder = renkoBuilders[symbol][brickPct];
      if (builder.lastBrickTimestampMs == null) continue;
      for (const combo of COMBOS_BY_BRICK_PCT[brickPct]) {
        const event = comboTrackers[symbol][combo.comboId].forceEodClose(builder.lastClose, builder.lastBrickTimestampMs);
        if (event) dispatchEvent(symbol, event);
      }
    }
  }
}

function scheduleBarFlush() {
  setInterval(() => {
    const now = Date.now();
    for (const symbol of Object.keys(symbols)) {
      const oneMinBar = tickBuilders[symbol].flushIfStale(now);
      if (oneMinBar) ingestOneMinBar(symbol, oneMinBar);
      const fiveMinBar = fiveMinAggs[symbol].flushIfStale(now);
      if (fiveMinBar) processFiveMinBar(symbol, fiveMinBar);
    }
    checkEodSweep();
    stateStore.saveCheckpoint(buildCheckpointSnapshot()); // internally debounced -- safe to call every tick
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
            guid: `renko-live-${Date.now()}`,
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

            const closedBar = tickBuilders[symbol].onTick(tick);
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

async function main() {
  if (!UPSTOX_TOKEN) {
    console.error('UPSTOX_ACCESS_TOKEN not set — cannot start.');
    process.exit(1);
  }
  console.log(`Renko combo-grid live streamer starting. ${Object.keys(symbols).length} symbols, ${COMBOS.length} combos each. Telegram-alerted combo: ${comboLabel(WINNING_COMBO_ID)}.`);
  console.log(`Telegram alerts: ${PAPER_ALERTS_ENABLED ? 'ENABLED (paper-labeled)' : 'SUPPRESSED (logging only)'}`);

  await initProtobuf();
  await syncFromRemote();
  await seedAllSymbols();
  scheduleBarFlush();

  let attempt = 0;
  for (;;) {
    const { reason } = await connectAndRun();
    if (reason === 'sigterm' || reason === 'sigint') {
      console.log('Shutting down (', reason, ') -- pushing final state checkpoint...');
      await stateStore.saveCheckpoint(buildCheckpointSnapshot(), true);
      process.exit(0);
    }
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
