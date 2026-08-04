'use strict';

/**
 * DarvasBox SHADOW-TRADE tick streamer -- one deliberate, already-vetted
 * combo (not a forward-test grid): 0.25% brick, BOTH directions (DarvasBox's
 * getEntry is symmetric -- LONG on a confirmed-box breakout above, SHORT
 * on a breakdown below; see strategies.js). Brick size chosen from the
 * stop-loss sweep run 2026-07-27 across the real 21-holding portfolio.
 *
 * Exit mechanism REPLACED 2026-07-28: ALL stop-loss logic -- flat %,
 * box-trail, chandelier -- was scrapped outright. Exit is now purely a
 * 9/20 EMA crossover computed on 5-minute bars, checked in
 * DarvasLiveTracker::checkEmaCrossExit. There is deliberately NO stop-loss
 * of any kind: a losing trade rides until the EMAs cross or the forced EOD
 * square-off, whichever comes first. Chosen from a same-day backtest
 * against that day's actual 23 booked trades: 9/20 EMA on 5-min bars beat
 * the real flat-1%-stop result (+3,181 vs +2,828); see darvas_tracker.js's
 * fork docstring for the full comparison and the earlier 1-min variants
 * that were tried and rejected.
 *
 * Entry-brick granularity CHANGED 2026-07-30: bricks now build from
 * COMPLETED 5-minute bars instead of 1-minute bars (see
 * completedFiveMinBars' docstring for why "completed" matters and how a
 * naive switch would have reintroduced the exact phantom-brick bug the
 * 2026-07-28 1-min-bar fix closed). Chosen from a same-day backtest run
 * across all 18 symbols isolating brick granularity from the exit EMA
 * period (both held at EMA(9,20)): 5-min-brick entries returned +2.37%
 * (7 trades, 57% win rate) vs 1-min-brick entries' -2.20% (30 trades, 33%
 * win rate) on 2026-07-30's actual price action -- the 1-min bricks were
 * generating far more, noisier breakout signals that the EMA exit then had
 * to unwind at a loss. Flagged: this is a single trading day's sample (7
 * trades), and 4 of those 7 wins were EOD square-offs rather than genuine
 * EMA-cross exits, so treat this as a promising lead worth monitoring
 * forward, not a settled result.
 *
 * Built on the same tick-WebSocket architecture as
 * ../live/streamer.js (auth flow, protobuf decode, reconnect/backoff,
 * TickBarBuilder) -- copied fresh into this directory rather than required
 * cross-directory, since each strategy's live/ directory is its own
 * independently-deployed Railway service (see MarketDataFeedV3.proto's own
 * docstring in the sibling directories for why).
 *
 * THE key deliberate difference from ../live/streamer.js: brick-CONFIRMED
 * entries are priced at the live LTP at confirmation time, not the
 * theoretical brick close -- built into DarvasLiveTracker itself, not
 * bolted on afterward. This directly reflects the lesson from the
 * LTP-vs-brick-price analysis done on the Renko N/K grid: a brick's close
 * can already be stale by the time it's confirmed and dispatched, and
 * measuring that gap after the fact isn't the same as trading on it. The
 * EMA-cross exit is priced the same way (LTP at confirmation, falling back
 * to the 5-min bar's close).
 *
 * Requires UPSTOX_ACCESS_TOKEN, GITHUB_TOKEN, and (optionally)
 * TELEGRAM_BOT_TOKEN env vars.
 */

const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('path');

const { buildRenkoBricks } = require('./renko');
const { DarvasLiveTracker } = require('./darvas_tracker');
const { syncFromRemote, recordAndPush, isDuplicateEvent, getTodaysExits } = require('./trade_log');
const { syncFromRemote: syncTrackedStateFromRemote, loadTrackedState, saveAndPushTrackedState } = require('./tracked_state');
const { ShadowDualFilterTracker } = require('./shadow_dual_filter_tracker');
const { syncFromRemote: syncShadowLogFromRemote, recordAndPush: recordAndPushShadowEvent } = require('./shadow_log');
const { DarvasVariantTracker } = require('./variant_tracker');
const { syncFromRemote: syncVariantLogFromRemote, recordAndPush: recordAndPushVariantEvent } = require('./variant_log');
const {
  syncFromRemote: syncVariantStateFromRemote,
  loadTrackedState: loadVariantState,
  saveAndPushTrackedState: saveAndPushVariantState,
} = require('./variant_tracked_state');
const { TickBarBuilder } = require('./tick_bar_builder');
const { MARKET_OPEN_MIN, MARKET_CLOSE_MIN, istMinutesOfDay, istDateStr, nowIst, aggregateTo5Min, aggregateTo5MinMultiDay } = require('./bar_aggregator');

// PDH/PDL break-&-retest scalp scanner (halal Nifty-50 subset) -- merged into
// this process 2026-08-04 so it shares this service's already-working Upstox
// WebSocket connection instead of opening its own (which was persistently
// rejected with 403 Forbidden as a standalone Railway service; root cause
// never confirmed, see pdh-pdl-strategy/live/streamer.js history). Runs off
// the SAME decoded feed messages (mode:'full' already includes marketOHLC,
// not just ltpc) and the SAME merged subscription -- no separate protobuf
// load, no separate WS connection. Fully isolated data/state (own trackers,
// own Postgres tables pdh_pdl.*, own Telegram formatting) from DarvasBox's
// real trading logic; a bug here cannot affect real trades. See
// pdh-pdl-strategy/live/streamer.js (original standalone service, code kept
// there for reference) and pdh_pdl_engine.js's docstring for the strategy.
const { BarAggregator: PdhPdlBarAggregator } = require('./pdhpdl_bar_aggregator');
const { PdhPdlTracker, istMin: pdhpdlIstMin } = require('./pdhpdl_engine');
const { fetchLevels: fetchPdhPdlLevels } = require('./pdhpdl_prev_day_levels');
const { DB: PdhPdlDB } = require('./pdhpdl_db');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = (process.env.DARVAS_TELEGRAM_CHAT_IDS || '5937539323,-5338709046').split(',');
const PAPER_ALERTS_ENABLED = process.env.DARVAS_TELEGRAM_ENABLED !== 'false';
const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const HISTORICAL_INTRADAY_BASE = 'https://api.upstox.com/v3/historical-candle/intraday';
const HISTORICAL_RANGE_BASE = 'https://api.upstox.com/v3/historical-candle'; // date-ranged (non-today) candles, for EMA warm-up
const FLUSH_POLL_MS = 15 * 1000;
const BACKFILL_DELAY_MS = 150;
const EMA_WARMUP_LOOKBACK_DAYS = 12; // calendar days back (~8 trading days) -- comfortably converges EMA(9)/EMA(20) before today's first bar; see bar_aggregator.js's aggregateTo5MinMultiDay docstring

const BRICK_PCT = 0.0025; // 0.25%, deliberate -- see module docstring
const BRICK_LABEL = '0.25';
const ENTRY_LABEL = '0.25% brick (5-min)'; // entry granularity changed 2026-07-30 -- see module docstring
const EXIT_LABEL = '9/20 EMA cross (5-min), no stop-loss'; // revised 2026-07-28 -- see module docstring

// Real held qty per symbol -- same figures as the portfolio backtest's HOLDINGS
// (renko-8-indicators/portfolio_sell_high_buy_low_intrabar.js), so rupee P&L
// here reflects your actual position size, not a flat notional.
const QUANTITIES = {
  CONCOR: 23, GAIL: 75, HATHWAY: 58, HINDCOPPER: 42, JSWINFRA: 66,
  MHRIL: 52, NHPC: 350, OLAELEC: 3059, ORIENTELEC: 226, RAILTEL: 14,
  RVNL: 961, SUZLON: 615, WAAREEENER: 56, ADSL: 52, 'ARE&M': 15, NCC: 61,
  TEXRAIL: 76, TITAGARH: 16,
};

const symbols = require('./symbols.json');
const keyToSymbol = {};
for (const [symbol, key] of Object.entries(symbols)) keyToSymbol[key] = symbol;

const tickBuilders = {}; // symbol -> TickBarBuilder
const oneMinBars = {};   // symbol -> today's closed 1-min bars, in-memory only
const trackers = {};     // symbol -> DarvasLiveTracker
// symbol -> ShadowDualFilterTracker -- dual-filter (candle-EMA + brick-EMA +
// volume-spike, pending-confirmation) experiment running alongside the real
// tracker, fed the exact same live bricks/bars5. See shadow_dual_filter_tracker.js's
// module docstring for the full design rationale. Structurally isolated: never
// reads or writes `trackers`, `this.position` on the real tracker, or the real
// trade log -- a bug here cannot affect live trading.
const shadowTrackers = {};
// symbol -> DarvasVariantTracker -- the A/B variant (anti-chase entry +
// EOD/wide-catastrophic-stop exit, no EMA-cross) running alongside the real
// tracker, fed the exact same live bricks/bars and the SAME live-price fn.
// Structurally isolated: never reads or writes `trackers`, the real tracker's
// position, or the real trade log -- a bug here cannot affect live trading.
// See variant_tracker.js's module docstring.
const variantTrackers = {};
// symbol -> 5-min bars from BEFORE today (EMA_WARMUP_LOOKBACK_DAYS calendar
// days), fetched once/day and never mutated intraday. Prepended to today's
// growing bars5 before every checkEmaCrossExit call so EMA(9)/EMA(20) are
// already fully converged at market open instead of needing ~100 minutes
// to produce a first value -- see bar_aggregator.js's aggregateTo5MinMultiDay
// docstring for the full reasoning (this fixes a confirmed real bug, not
// just a cosmetic mismatch with charting platforms).
const historicalBars5 = {};
for (const symbol of Object.keys(symbols)) {
  oneMinBars[symbol] = [];
  historicalBars5[symbol] = [];
  trackers[symbol] = new DarvasLiveTracker(symbol, () => {
    const b = tickBuilders[symbol];
    return b ? b.getLivePrice() : null;
  });
  shadowTrackers[symbol] = new ShadowDualFilterTracker(symbol);
  // Same live-price fn as the real tracker -- the variant tests the LTP fill.
  variantTrackers[symbol] = new DarvasVariantTracker(symbol, () => {
    const b = tickBuilders[symbol];
    return b ? b.getLivePrice() : null;
  });
}
// ---- PDH/PDL state (fully separate from DarvasBox's own state above) ------
const pdhpdlSymbols = require('./pdhpdl_symbols.json');
const pdhpdlKeyToSymbol = {};
for (const [symbol, key] of Object.entries(pdhpdlSymbols)) pdhpdlKeyToSymbol[key] = symbol;
const pdhpdlDb = new PdhPdlDB();
const pdhpdlTrackers = {};  // symbol -> PdhPdlTracker
const pdhpdlAgg5 = {};      // symbol -> BarAggregator(5)
const pdhpdlAgg15 = {};     // symbol -> BarAggregator(15)
const pdhpdlSignalIds = {}; // symbol -> Postgres pdh_pdl.signals.id
let pdhpdlLastPreppedDate = null;

let currentDate = null;
let protobufRoot = null;
let lastGoodTickMs = null;

// Stale-connection watchdog (added 2026-07-30, real incident: the streamer sat
// silently "RUNNING" for 15+ min across all 18 symbols after the Upstox feed
// went half-dead without ever firing 'close' or 'error' -- a classic zombie
// WebSocket, common with NAT/load-balancer idle timeouts or a silent drop on
// the server end. Neither event fires because nothing actively probes the
// connection, so main()'s reconnect loop (which only advances when
// connectAndRun()'s promise resolves via close/error/sigterm) never triggers.
// lastActivityMs is updated on 'open' AND every valid tick; a periodic check
// force-terminates the socket if it goes stale during market hours, which
// fires 'close' and lets the existing reconnect logic do its job. Deliberately
// a SEPARATE variable from lastGoodTickMs (which backfillGapIfNeeded uses with
// different semantics -- "has any tick ever been seen" -- not touching that).
const WS_STALE_TIMEOUT_MS = 90 * 1000;
const WATCHDOG_INTERVAL_MS = 30 * 1000;
let lastActivityMs = null;
let currentWs = null;

// Realtime running P&L for the day -- updated on every EXIT (including EOD
// square-offs), so "day so far" is always current, not something pieced
// together afterward from individual alerts. Reset each new trading day.
// eodSummarySent guards the one-time EOD summary broadcast (checkEodSweep
// runs every FLUSH_POLL_MS after close, so without a guard it would resend
// on every poll once all positions are flat).
let dayStats = { trades: 0, wins: 0, totalPnlPct: 0, totalPnlRs: 0, hasRupees: false };
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

/** Past EMA_WARMUP_LOOKBACK_DAYS calendar days of 1-min candles (up to yesterday -- today comes from the live/intraday path), aggregated to multi-day-safe 5-min bars. */
async function fetchHistorical5MinBars(instrumentKey) {
  const to = isoDaysAgo(1);
  const from = isoDaysAgo(EMA_WARMUP_LOOKBACK_DAYS);
  const url = `${HISTORICAL_RANGE_BASE}/${encodeURIComponent(instrumentKey)}/minutes/1/${to}/${from}`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${UPSTOX_TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`Upstox status: ${body.status}`);
  const candles = (body.data.candles || [])
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
  return aggregateTo5MinMultiDay(candles);
}

/** Loads historicalBars5 for every symbol -- called once at startup and once per new trading day. A per-symbol failure falls back to an empty (cold-start) warm-up for that symbol rather than blocking the others. */
async function loadEmaWarmup() {
  console.log(`Fetching ${EMA_WARMUP_LOOKBACK_DAYS} calendar days of history for continuous EMA warm-up (${Object.keys(symbols).length} symbols)...`);
  let ok = 0, failed = 0;
  for (const symbol of Object.keys(symbols)) {
    try {
      historicalBars5[symbol] = await fetchHistorical5MinBars(symbols[symbol]);
      ok++;
    } catch (e) {
      console.warn(`  EMA warm-up fetch failed for ${symbol}: ${e.message} -- falling back to cold-start (no warm-up) for this symbol today.`);
      historicalBars5[symbol] = [];
      failed++;
    }
    await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
  }
  console.log(`EMA warm-up history loaded: ${ok}/${Object.keys(symbols).length} symbols (${failed} failed).`);
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
  return `🌗 SHADOW TRADE — DarvasBox [${ENTRY_LABEL}, ${EXIT_LABEL}] (paper, not a real order)\n${arrow} ${e.direction}: ${e.symbol}\nEntry (LTP): ₹${e.entry.toFixed(2)}${driftNote}`;
}
function formatExitAlert(e, runningTotal) {
  const sign = e.pnlPct >= 0 ? '+' : '';
  const driftNote = e.livePriceAvailable && e.theoreticalExit != null && e.theoreticalExit !== e.exitPrice
    ? ` (5-min bar close was ₹${e.theoreticalExit.toFixed(2)})`
    : '';
  const rsNote = runningTotal.hasRupees ? ` / ${e.rsSign}₹${Math.abs(e.pnlRs).toFixed(0)}` : '';
  const totalRsNote = runningTotal.hasRupees ? ` / ${runningTotal.totalPnlRs >= 0 ? '+' : '−'}₹${Math.abs(runningTotal.totalPnlRs).toFixed(0)}` : '';
  return `🌗 SHADOW TRADE — DarvasBox [${ENTRY_LABEL}, ${EXIT_LABEL}] position closed (paper)\n${e.symbol} ${e.direction}\nEntry: ₹${e.entry.toFixed(2)} → Exit (LTP): ₹${e.exitPrice.toFixed(2)}${driftNote}\nReason: ${e.action}\nP&L: ${sign}${e.pnlPct.toFixed(2)}%${rsNote} (gross, no costs applied)\n\n📊 Day so far: ${runningTotal.trades} trades, ${runningTotal.wins} wins, total ${runningTotal.totalPnlPct >= 0 ? '+' : ''}${runningTotal.totalPnlPct.toFixed(2)}%${totalRsNote}`;
}

/** Realtime day-total update -- called on every EXIT (including EOD square-offs), so "day so far" is always current. */
function updateDayStats(e) {
  const qty = QUANTITIES[e.symbol];
  dayStats.trades += 1;
  if (e.pnlPct > 0) dayStats.wins += 1;
  dayStats.totalPnlPct += e.pnlPct;
  if (qty != null) {
    dayStats.hasRupees = true;
    const pnlRs = e.direction === 'LONG' ? (e.exitPrice - e.entry) * qty : (e.entry - e.exitPrice) * qty;
    e.pnlRs = pnlRs;
    e.rsSign = pnlRs >= 0 ? '+' : '−';
    dayStats.totalPnlRs += pnlRs;
  }
}

function formatEodSummary() {
  const s = dayStats;
  const winRate = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0.0';
  const rsLine = s.hasRupees ? `\nTotal P&L (₹, real holding sizes): ${s.totalPnlRs >= 0 ? '+' : '−'}₹${Math.abs(s.totalPnlRs).toFixed(0)}` : '';
  return `🌗 EOD SUMMARY — DarvasBox shadow trade [${ENTRY_LABEL}, ${EXIT_LABEL}], ${currentDate}\nTrades: ${s.trades} | Wins: ${s.wins} (${winRate}%)\nTotal gross P&L: ${s.totalPnlPct >= 0 ? '+' : ''}${s.totalPnlPct.toFixed(2)}%${rsLine}\n(gross, no costs applied)`;
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
    updateDayStats(e);
    sendTelegramAlert(formatExitAlert(e, dayStats)).catch((err) => console.error('sendTelegramAlert threw:', err.message));
    recordAndPush(e, dateStr).catch((err) => console.error('recordAndPush threw:', err.message));
  }
  // Persist position state on every ENTRY/EXIT (see darvas_tracker.js's toJSON
  // docstring for why this exists) -- cheap (one small object per symbol), and
  // must happen right after `this.position` changes, not on some separate timer,
  // so a restart landing between this event and the next one always sees the
  // correct up-to-date state.
  saveAndPushTrackedState(trackers).catch((err) => console.error('saveAndPushTrackedState threw:', err.message));
}

/** Dual-filter shadow experiment -- logs what the pending-confirmation filter would
 * have done, to its OWN branch/file (shadow_log.js), never touching real trades,
 * the real trade log, or Telegram. See shadow_dual_filter_tracker.js's docstring. */
function dispatchShadowEvent(e) {
  const { dateStr } = nowIst();
  recordAndPushShadowEvent(e, dateStr).catch((err) => console.error('shadow dispatchShadowEvent threw:', err.message));
}

/** A/B variant experiment -- logs to its OWN branch/file (variant_log.js) and
 * persists its OWN position state (variant_tracked_state.js), never touching
 * real trades, the real trade log, the dual-filter shadow, or Telegram. */
function dispatchVariantEvent(e) {
  e.brickPct = BRICK_LABEL;
  const { dateStr } = nowIst();
  recordAndPushVariantEvent(e, dateStr).catch((err) => console.error('variant dispatchVariantEvent threw:', err.message));
  // Persist on every ENTRY/EXIT, right after this.position changed -- same
  // reasoning as dispatchEvent's saveAndPushTrackedState (live-LTP fills mean
  // a restart can't safely re-derive an open position from a brick replay).
  saveAndPushVariantState(variantTrackers).catch((err) => console.error('saveAndPushVariantState threw:', err.message));
}

function maybeResetForNewDay(nowMs) {
  const dateStr = istDateStr(nowMs);
  if (dateStr === currentDate) return;
  currentDate = dateStr;
  dayStats = { trades: 0, wins: 0, totalPnlPct: 0, totalPnlRs: 0, hasRupees: false };
  eodSummarySent = false;
  for (const symbol of Object.keys(symbols)) {
    oneMinBars[symbol] = [];
    trackers[symbol].resetForNewDay();
    shadowTrackers[symbol].resetForNewDay();
    variantTrackers[symbol].resetForNewDay();
  }
  console.log(`New trading day: ${dateStr}. Tracker + in-memory 1-min bar buffers + day stats reset.`);
  // Push the now-all-null tracked state too -- otherwise a restart later
  // today would restore YESTERDAY's (already-closed) positions from the
  // stale file still sitting on the remote branch.
  saveAndPushTrackedState(trackers).catch((err) => console.error('saveAndPushTrackedState threw (new-day reset):', err.message));
  // Fire-and-forget: yesterday's historicalBars5 stays in place (only one
  // day stale, negligible given the multi-day convergence window) until
  // this completes -- not awaited so a slow multi-symbol refetch can never
  // block live tick processing.
  loadEmaWarmup().catch((e) => console.error('EMA warm-up reload for the new day failed:', e.message));
}

/**
 * Sends the one-time EOD summary once every open position has been swept
 * closed, guarded so a 15s-poll checkEodSweep doesn't resend it. Checks
 * MARKET_CLOSE_MIN itself (not just at the two call sites) as defense in
 * depth -- a real, unexplained early-fire was observed once (2026-07-28,
 * ~08:00 IST, "Trades: 0" message sent well before market open) that
 * couldn't be reproduced or root-caused via direct testing of the call
 * sites' own gates (both verified correct in isolation). Redundant gating
 * here closes the risk regardless of the actual cause.
 */
function maybeSendEodSummary() {
  if (eodSummarySent) return;
  const { minutesOfDay } = nowIst();
  if (minutesOfDay < MARKET_CLOSE_MIN) return;
  const anyOpen = Object.values(trackers).some((t) => t.position != null);
  if (anyOpen) return; // wait for checkEodSweep to finish closing everything first
  eodSummarySent = true;
  sendTelegramAlert(formatEodSummary()).catch((err) => console.error('sendTelegramAlert threw:', err.message));
}

/**
 * aggregateTo5Min's last returned bucket is whatever 1-min bars have arrived
 * so far for that 5-min window -- genuinely complete only once a bar from
 * the NEXT window has been seen. Feeding that still-forming bucket straight
 * into brick construction would reintroduce the exact bug the 2026-07-28
 * fix closed for 1-min bars (see this file's module docstring and the
 * OLAELEC incident it describes): a brick locking in off a rolling close
 * the 5-min candle never actually finished at. Completeness test: the
 * latest 1-min bar's own minute-of-day must land on a 5-min bucket boundary
 * (offset 4 mod 5, e.g. 09:19 completes the 09:15-09:19 bucket) -- if not,
 * the last bucket is still forming and gets dropped.
 */
function completedFiveMinBars(bars) {
  if (bars.length === 0) return [];
  const buckets = aggregateTo5Min(bars);
  const latestMin = istMinutesOfDay(bars[bars.length - 1].timestampMs);
  const lastBucketComplete = (latestMin - MARKET_OPEN_MIN) % 5 === 4;
  return lastBucketComplete ? buckets : buckets.slice(0, -1);
}

/**
 * Only ever called with a bar that's ALREADY CLOSED (TickBarBuilder.onTick
 * returns null until a minute genuinely finishes, and flushIfStale only
 * force-closes a bar whose minute has fully elapsed) -- so every entry in
 * oneMinBars[symbol] is a confirmed candle, never a still-forming one.
 *
 * Entry bricks build from COMPLETED 5-minute bars (changed 2026-07-30, see
 * module docstring for the backtest that motivated this and
 * completedFiveMinBars' docstring for why "completed" -- not just
 * aggregated -- matters here).
 */
function ingestOneMinBar(symbol, bar, silent) {
  const minutesOfDay = istMinutesOfDay(bar.timestampMs);
  if (minutesOfDay < MARKET_OPEN_MIN || minutesOfDay > MARKET_CLOSE_MIN + 15) return;

  oneMinBars[symbol].push(bar);
  const bars = oneMinBars[symbol];
  const bars5Today = completedFiveMinBars(bars);

  const bricks = buildRenkoBricks(bars5Today, BRICK_PCT);
  const tracker = trackers[symbol];
  // Historical prefix (fixed length within a day) + today's growing portion --
  // gives both the entry trend-filter and checkEmaCrossExit a continuously-
  // converged EMA instead of a cold start every morning. See
  // historicalBars5's declaration for why. EMA deliberately still uses the
  // full (possibly still-forming) aggregateTo5Min output, unlike the bricks
  // above -- a continuously-updating EMA on a forming bar is normal (any
  // live chart does this), it's only brick CONFIRMATION that can't tolerate
  // a rolling close.
  const bars5 = historicalBars5[symbol].concat(aggregateTo5Min(bars));
  // entryBars must be the SAME granularity bricks were built from (5-min,
  // not the raw 1-min `bars`) -- otherwise the volume-spike filter compares
  // a 5-min brick's volume against a 1-min trailing average and every entry
  // reads as a false spike. See darvas_tracker.js's processBricks docstring.
  const events = tracker.processBricks(bricks, bars5, bars5Today);
  const emaCrossEvent = tracker.checkEmaCrossExit(bars5);
  if (emaCrossEvent) events.push(emaCrossEvent);
  if (minutesOfDay >= MARKET_CLOSE_MIN) {
    const eodEvent = tracker.forceEodClose(bricks);
    if (eodEvent) events.push(eodEvent);
  }
  if (!silent) {
    for (const e of events) dispatchEvent(symbol, e);
    if (minutesOfDay >= MARKET_CLOSE_MIN) maybeSendEodSummary();
  }

  // Dual-filter shadow experiment -- dispatched even during silent backfill
  // (unlike the real events above): it's fully deterministic given the same
  // bricks/bars5 (no live-price dependency, no Telegram send), so replaying it
  // is harmless and the dedup-by-event-key guard in shadow_log.js handles it.
  const shadowTracker = shadowTrackers[symbol];
  const shadowEvents = shadowTracker.processBricks(bricks, bars5, bars5Today);
  const shadowExit = shadowTracker.checkEmaCrossExit(bars5);
  if (shadowExit) shadowEvents.push(shadowExit);
  if (minutesOfDay >= MARKET_CLOSE_MIN) {
    const shadowEod = shadowTracker.forceEodClose(bricks);
    if (shadowEod) shadowEvents.push(shadowEod);
  }
  for (const e of shadowEvents) dispatchShadowEvent(e);

  // A/B variant experiment -- mirrors the REAL tracker's cadence, NOT the
  // shadow's: it fills at the live LTP (non-deterministic), so it dispatches
  // only when NOT in silent backfill, exactly like the real events above.
  // Substitutes the anti-chase entry gate + EOD/wide-catastrophic-stop exit
  // (no EMA cross). Own log + state branch; never touches real trades.
  const variantTracker = variantTrackers[symbol];
  const variantEvents = variantTracker.processBricks(bricks, bars5, bars5Today);
  const variantStop = variantTracker.checkCatastrophicStop(bars); // raw 1-min bars -- fastest catastrophic-stop detection
  if (variantStop) variantEvents.push(variantStop);
  if (minutesOfDay >= MARKET_CLOSE_MIN) {
    const variantEod = variantTracker.forceEodClose(bricks);
    if (variantEod) variantEvents.push(variantEod);
  }
  if (!silent) {
    for (const e of variantEvents) dispatchVariantEvent(e);
  }
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
    const bars = oneMinBars[symbol];
    if (bars.length === 0) continue;
    // Trading hours (09:15-15:30) divide evenly into 5-min buckets, so by
    // MARKET_CLOSE_MIN the last bucket is always complete -- same helper as
    // ingestOneMinBar for consistency, not just a safety margin.
    const bricks = buildRenkoBricks(completedFiveMinBars(bars), BRICK_PCT);
    const eodEvent = trackers[symbol].forceEodClose(bricks);
    if (eodEvent) dispatchEvent(symbol, eodEvent);
    const shadowEod = shadowTrackers[symbol].forceEodClose(bricks);
    if (shadowEod) dispatchShadowEvent(shadowEod);
    const variantEod = variantTrackers[symbol].forceEodClose(bricks);
    if (variantEod) dispatchVariantEvent(variantEod);
  }
  maybeSendEodSummary();
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

// ---- PDH/PDL: candle extraction (reads the SAME decoded feed message ------
// darvasbox's own tick pipeline already decodes -- no separate protobuf load).
function extractOneMinCandles(feed) {
  const inner = feed.fullFeed && (feed.fullFeed.marketFF || feed.fullFeed.indexFF);
  if (!inner || !inner.marketOHLC || !inner.marketOHLC.ohlc) return [];
  return inner.marketOHLC.ohlc.filter((o) => o.interval === 'I1').map((o) => ({
    timestampMs: Number(o.ts), open: o.open, high: o.high, low: o.low, close: o.close, volume: Number(o.vol || 0),
  }));
}

// ---- PDH/PDL: daily prep (fetch prior-day PDH/PDL, fresh trackers) --------
function pdhpdlIstDate(ms) { return new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10); }
function pdhpdlIstTimeStr(ms) { return new Date(ms + 5.5 * 3600000).toISOString().slice(11, 16); }

async function pdhpdlPrepDay() {
  const date = pdhpdlIstDate(Date.now());
  console.log(`[pdh-pdl] Prepping ${date}: fetching prior-day PDH/PDL for ${Object.keys(pdhpdlSymbols).length} symbols...`);
  const { levels, failed } = await fetchPdhPdlLevels(pdhpdlSymbols, UPSTOX_TOKEN);
  for (const symbol of Object.keys(pdhpdlSymbols)) {
    pdhpdlTrackers[symbol] = new PdhPdlTracker(symbol);
    pdhpdlAgg5[symbol] = new PdhPdlBarAggregator(5, (bar) => pdhpdlHandle5(symbol, bar));
    pdhpdlAgg15[symbol] = new PdhPdlBarAggregator(15, (bar) => pdhpdlHandle15(symbol, bar));
    delete pdhpdlSignalIds[symbol];
    const lv = levels[symbol];
    if (lv) pdhpdlTrackers[symbol].setLevels(lv.pdh, lv.pdl);
  }
  pdhpdlLastPreppedDate = date;
  const ok = Object.keys(levels).length;
  console.log(`[pdh-pdl]   levels set for ${ok}/${Object.keys(pdhpdlSymbols).length} symbols` + (failed.length ? `; failed: ${failed.join(', ')}` : ''));
}

/** Runs every minute: (re)prep once per day at/after 09:10 IST -- own independent schedule from DarvasBox's own new-day reset. */
function schedulePdhPdlDailyPrep() {
  setInterval(() => {
    const now = Date.now();
    if (pdhpdlIstDate(now) !== pdhpdlLastPreppedDate && pdhpdlIstMin(now) >= 9 * 60 + 10) {
      pdhpdlPrepDay().catch((e) => console.error('[pdh-pdl] prepDay failed:', e.message));
    }
  }, 60000);
}

// ---- PDH/PDL: Telegram (reuses DarvasBox's own TELEGRAM_TOKEN/chat ids) ---
async function sendPdhPdlTelegram(text) {
  console.log('[PDH-PDL ALERT]', text.replace(/\n/g, ' | '));
  if (!TELEGRAM_TOKEN) return false;
  let allOk = true;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) { allOk = false; console.warn(`  [pdh-pdl] Telegram send failed for ${chatId}: HTTP ${res.status}`); }
    } catch (e) { allOk = false; console.warn(`  [pdh-pdl] Telegram send error for ${chatId}: ${e.message}`); }
  }
  return allOk;
}

const pdhpdlF = (x) => (x == null ? '—' : Number(x).toFixed(2));

function pdhpdlFmtArmed(e) {
  return [`⚡ PDH/PDL ARMED — ${e.symbol} (${e.direction})`,
    `${e.levelType} ${pdhpdlF(e.level)} broken (15m close ${pdhpdlF(e.breakClose)}) at ${pdhpdlIstTimeStr(e.breakTs)} IST.`,
    `Watch for the ${e.direction === 'LONG' ? '5-min retest of PDH' : '5-min retest of PDL'}.`].join('\n');
}
function pdhpdlFmtSetup(e) {
  return [`${e.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} SETUP — ${e.symbol}`,
    `Trigger: ${e.triggerType === 'PIN' ? 'one-shot pin bar' : 'engulfing'} at ${e.levelType} ${pdhpdlF(e.level)}` +
      (e.effRatio != null ? ` (eff ${Number(e.effRatio).toFixed(2)})` : ''),
    `Entry ${pdhpdlF(e.entryPx)}  |  SL ${pdhpdlF(e.sl)}  (R ${pdhpdlF(e.r)})`,
    `T 1.5R ${pdhpdlF(e.t1p5)}   T 2R ${pdhpdlF(e.t2)}   T 3R ${pdhpdlF(e.t3)}`,
    `${pdhpdlIstTimeStr(e.entryTs)} IST · alert-only, no order placed.`].join('\n');
}
function pdhpdlFmtMilestone(e) {
  return `🎯 ${e.symbol} reached ${e.level} @ ${pdhpdlF(e.price)} (${pdhpdlIstTimeStr(e.ts)} IST).` +
    (e.level === 'T1.5R' ? ' Consider trailing SL to breakeven.' : '');
}
function pdhpdlFmtOutcome(e) {
  const icon = e.result === 'T3R' ? '✅' : e.result === 'SL' ? '🛑' : '⏹️';
  return [`${icon} ${e.symbol} closed — ${e.result} @ ${pdhpdlF(e.exitPx)}`,
    `R-multiple: ${e.rMultiple >= 0 ? '+' : ''}${Number(e.rMultiple).toFixed(2)}R  ·  MFE ${Number(e.mfeR).toFixed(2)}R / MAE ${Number(e.maeR).toFixed(2)}R`,
    `${pdhpdlIstTimeStr(e.closedTs)} IST.`].join('\n');
}

async function pdhpdlEmit(alertType, symbol, text, signalId) {
  const ok = await sendPdhPdlTelegram(text);
  await pdhpdlDb.insertAlert({ signalId, symbol, alertType, chatId: TELEGRAM_CHAT_IDS.join(','), text, sentOk: ok });
}

async function pdhpdlHandleEvents(events) {
  for (const e of events) {
    if (e.type === 'ARMED') {
      const td = pdhpdlIstDate(e.breakTs);
      await pdhpdlDb.insertArmed(e, td);
      await pdhpdlEmit('ARMED', e.symbol, pdhpdlFmtArmed(e), null);
    } else if (e.type === 'SETUP') {
      const td = pdhpdlIstDate(e.entryTs);
      const id = await pdhpdlDb.insertSignal(e, td);
      if (id != null) pdhpdlSignalIds[e.symbol] = id;
      await pdhpdlEmit('SETUP', e.symbol, pdhpdlFmtSetup(e), pdhpdlSignalIds[e.symbol]);
    } else if (e.type === 'MILESTONE') {
      await pdhpdlDb.markMilestone(pdhpdlSignalIds[e.symbol], e.level, e.ts);
      await pdhpdlEmit(e.level, e.symbol, pdhpdlFmtMilestone(e), pdhpdlSignalIds[e.symbol]);
    } else if (e.type === 'OUTCOME') {
      await pdhpdlDb.closeOutcome(pdhpdlSignalIds[e.symbol], e);
      await pdhpdlEmit(e.result, e.symbol, pdhpdlFmtOutcome(e), pdhpdlSignalIds[e.symbol]);
    }
  }
}

// Serialize event handling per symbol so a signal's INSERT always completes
// before its outcome UPDATE -- same reasoning as DarvasBox's own dispatchEvent.
const pdhpdlChains = {};
function pdhpdlEnqueue(symbol, events) {
  if (!events || events.length === 0) return;
  pdhpdlChains[symbol] = (pdhpdlChains[symbol] || Promise.resolve())
    .then(() => pdhpdlHandleEvents(events))
    .catch((e) => console.error(`[pdh-pdl] handleEvents error [${symbol}]:`, e.message));
}
function pdhpdlHandle5(symbol, bar) { const t = pdhpdlTrackers[symbol]; if (t) pdhpdlEnqueue(symbol, t.onNew5mBar(bar)); }
function pdhpdlHandle15(symbol, bar) { const t = pdhpdlTrackers[symbol]; if (t) pdhpdlEnqueue(symbol, t.onNew15mBar(bar)); }

/** Force-closes any still-forming PDH/PDL bars/positions -- called on process shutdown, mirroring the original standalone service's finalizeDay(). */
function pdhpdlFinalizeDay() {
  console.log('[pdh-pdl] Finalizing day...');
  for (const symbol of Object.keys(pdhpdlAgg5)) {
    pdhpdlAgg5[symbol].flushRemaining();
    pdhpdlAgg15[symbol] && pdhpdlAgg15[symbol].flushRemaining();
  }
  for (const symbol of Object.keys(pdhpdlTrackers)) pdhpdlEnqueue(symbol, pdhpdlTrackers[symbol].forceEndOfDay());
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
        console.log('Connected. Subscribing to', Object.keys(symbols).length, 'DarvasBox symbols +', Object.keys(pdhpdlSymbols).length, 'PDH/PDL symbols...');
        lastActivityMs = Date.now(); // gives the subscription a full WS_STALE_TIMEOUT_MS window to start producing ticks
        setTimeout(() => {
          // Merged + deduped -- PDH/PDL (halal Nifty-50 subset) and DarvasBox's
          // 18 holdings overlap on some symbols; a single 'full' subscription
          // covers both (mode:'full' already includes marketOHLC, not just ltpc).
          const instrumentKeys = Array.from(new Set([...Object.values(symbols), ...Object.values(pdhpdlSymbols)]));
          ws.send(Buffer.from(JSON.stringify({
            guid: `darvasbox-shadow-${Date.now()}`,
            method: 'sub',
            data: { mode: 'full', instrumentKeys },
          })));
          console.log('Subscription sent (', instrumentKeys.length, 'unique instrument keys ).');
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
          if (symbol) {
            try {
              const tick = extractTick(feed);
              if (tick) {
                lastGoodTickMs = Date.now();
                lastActivityMs = lastGoodTickMs;

                const closedBar = getOrCreateTickBuilder(symbol).onTick(tick);
                if (closedBar) ingestOneMinBar(symbol, closedBar, false);
              }
            } catch (e) {
              console.error(`Tick processing threw for ${instrumentKey}:`, e.message, e.stack);
            }
          }

          // PDH/PDL: independent of DarvasBox's own symbol map above -- a
          // symbol can be subscribed for one strategy, the other, or both.
          const pdhpdlSymbol = pdhpdlKeyToSymbol[instrumentKey];
          if (pdhpdlSymbol) {
            try {
              const candles = extractOneMinCandles(feed);
              for (const c of candles) {
                pdhpdlAgg5[pdhpdlSymbol] && pdhpdlAgg5[pdhpdlSymbol].push(c);
                pdhpdlAgg15[pdhpdlSymbol] && pdhpdlAgg15[pdhpdlSymbol].push(c);
              }
            } catch (e) {
              console.error(`[pdh-pdl] Candle processing threw for ${instrumentKey}:`, e.message);
            }
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

      process.once('SIGTERM', () => { console.log('SIGTERM: closing feed connection...'); pdhpdlFinalizeDay(); ws.close(); setTimeout(() => finish('sigterm'), 500); });
      process.once('SIGINT', () => { console.log('SIGINT: closing feed connection...'); pdhpdlFinalizeDay(); ws.close(); setTimeout(() => finish('sigint'), 500); });
    })();
  });
}

/**
 * Runs once every WATCHDOG_INTERVAL_MS for the life of the process (started
 * once in main(), NOT per-connection) -- forcibly terminates the current
 * WebSocket if it's gone stale during market hours, i.e. no tick AND no
 * fresh 'open' event in the last WS_STALE_TIMEOUT_MS. terminate() (not
 * close()) because a truly zombie connection won't answer a close handshake
 * either -- terminate() destroys the underlying socket directly, which
 * reliably fires 'close' and lets main()'s existing reconnect loop take over.
 * Only checked during market hours (+15min grace, matching ingestOneMinBar's
 * own convention) since silence outside that window is expected, not a bug.
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
  console.log(`DarvasBox SHADOW streamer starting. ${Object.keys(symbols).length} symbols, ${ENTRY_LABEL}, ${EXIT_LABEL}, LTP-confirmed entries/exits.`);
  console.log(`Telegram alerts: ${PAPER_ALERTS_ENABLED ? 'ENABLED (paper-labeled)' : 'SUPPRESSED (logging only)'}`);

  await initProtobuf();

  // PDH/PDL: own Postgres init + daily prep, independent of DarvasBox's own
  // GitHub-based persistence below. Awaited before the connect loop so
  // pdhpdlTrackers/pdhpdlAgg5/pdhpdlAgg15 are populated before the first
  // feed message can arrive.
  await pdhpdlDb.init();
  await pdhpdlPrepDay();
  schedulePdhPdlDailyPrep();

  await syncFromRemote();
  // Shadow experiment log -- fully deterministic given bricks/bars5 (no live-price
  // dependency), so a restart's backfill replay just re-derives identical shadow
  // events; syncing first only avoids re-pushing what's already recorded remotely.
  await syncShadowLogFromRemote();
  // A/B variant experiment log -- its own branch; sync first for the same reason.
  await syncVariantLogFromRemote();

  // Restore any already-open positions BEFORE startupBackfillIfNeeded() runs --
  // see darvas_tracker.js's toJSON docstring for the real incident this fixes.
  // Must happen before the backfill replay: processBricks skips entry-detection
  // entirely once `this.position` is set, so restoring first means the replay
  // can never re-derive (and mis-price) an entry for a symbol that's already
  // holding a position from before the restart.
  await syncTrackedStateFromRemote();
  const trackedState = loadTrackedState();
  const { dateStr: startupDateStr } = nowIst();
  let restoredCount = 0;
  for (const symbol of Object.keys(symbols)) {
    const persisted = trackedState[symbol];
    if (!persisted || !persisted.position) continue;
    // Positions are day-scoped (DarvasBox resets daily) -- a position whose
    // entry predates today is stale (e.g. the service crashed before ever
    // EOD-closing it) and must NOT be silently carried into a new day.
    if (istDateStr(persisted.position.entryTimestampMs) !== startupDateStr) {
      console.warn(`  ${symbol}: persisted position is from a prior day -- discarding rather than carrying it into today.`);
      continue;
    }
    trackers[symbol].restorePosition(persisted);
    restoredCount++;
  }
  if (restoredCount > 0) {
    console.log(`Restored ${restoredCount} already-open position(s) from persisted state.`);
  }

  // A/B variant experiment -- restore its OWN persisted positions, from its OWN
  // state file, in a separate loop so it stays fully isolated from the real
  // tracker's restore (the two can legitimately hold different positions). Same
  // day-scope guard: a position whose entry predates today is stale, discard it.
  await syncVariantStateFromRemote();
  const variantState = loadVariantState();
  let variantRestored = 0;
  for (const symbol of Object.keys(symbols)) {
    const persisted = variantState[symbol];
    if (!persisted || !persisted.position) continue;
    if (istDateStr(persisted.position.entryTimestampMs) !== startupDateStr) {
      console.warn(`  [variant] ${symbol}: persisted position is from a prior day -- discarding.`);
      continue;
    }
    variantTrackers[symbol].restorePosition(persisted);
    variantRestored++;
  }
  if (variantRestored > 0) {
    console.log(`[variant] Restored ${variantRestored} already-open position(s) from persisted state.`);
  }

  // Rebuild today's running P&L from the persisted log BEFORE anything else --
  // startupBackfillIfNeeded() replays bricks silently (by design, so a restart
  // never re-alerts something that already happened), so it does NOT repopulate
  // dayStats on its own. Without this, any mid-day restart (redeploy, crash-
  // recover, a token refresh) would silently reset "day so far" to zero and
  // could even fire a premature EOD summary showing 0 trades.
  const { dateStr: todayStr } = nowIst();
  currentDate = todayStr; // set BEFORE the first tick so maybeResetForNewDay doesn't immediately wipe what we just rebuilt
  for (const e of getTodaysExits(todayStr, istDateStr)) updateDayStats(e);
  if (dayStats.trades > 0) {
    console.log(`Restored today's running P&L from the persisted log: ${dayStats.trades} trades, ${dayStats.wins} wins, total ${dayStats.totalPnlPct.toFixed(2)}% so far.`);
  }

  // Awaited here (unlike maybeResetForNewDay's fire-and-forget reload) --
  // startupBackfillIfNeeded() replays today's bricks through the same
  // checkEmaCrossExit path a live tick would, so it needs a real warm-up
  // prefix in place BEFORE that replay runs, not an empty one.
  await loadEmaWarmup();
  await startupBackfillIfNeeded();
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
