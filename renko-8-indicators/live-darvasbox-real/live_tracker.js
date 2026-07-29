'use strict';

/**
 * REAL-MONEY per-symbol DarvasBox tracker. Entry signal and 9/20 EMA-cross
 * exit signal are IDENTICAL logic to live-darvasbox-shadow/darvas_tracker.js
 * (same strategies.js getEntry, same EMA-cross math) -- the only things
 * that differ from the paper tracker are:
 *   1. Every entry/exit places a REAL Upstox order via OrderClient and
 *      waits for a CONFIRMED fill before touching position state at all.
 *      A rejected or unconfirmed order never gets tracked as a position.
 *   2. A catastrophic stop (wide %, checked against real-time bars --
 *      NOT the EMA cross) exists purely as a backstop, since the paper
 *      design deliberately has no stop-loss at all. This is NOT meant to
 *      fire under normal conditions -- it's there so a single bad move
 *      before the EMA cross catches up can't be unbounded.
 *   3. Realized P&L on every exit is reported to the shared RiskManager,
 *      which can block new entries for the rest of the day.
 *   4. If a CLOSING order (exit) doesn't confirm as filled, this tracker
 *      does NOT clear its position and does NOT retry the close itself --
 *      retrying a market sell/buy blind risks a double fill if the first
 *      attempt actually succeeded but the status check just failed. It
 *      alerts loudly and leaves `exitAttemptPending` set so a human
 *      checks Upstox directly. Entries follow the same non-retry
 *      philosophy for the same reason.
 *   5. Entry gained the SAME trend-alignment filter as the paper tracker
 *      (2026-07-29): a box breakout only places a real order if EMA9/EMA20
 *      (5-min bars) already agree with the breakout direction. See
 *      live-darvasbox-shadow/darvas_tracker.js's fork note (3) for the full
 *      reasoning/backtest. Fails OPEN (places the order) if EMA data isn't
 *      available -- a missing warm-up fetch must not silently block a
 *      symbol from ever trading that day.
 *   6. Entry gained the SAME volume-spike filter as the paper tracker
 *      (2026-07-29): a box breakout is suppressed (no real order placed) if
 *      the entry brick's volume is >= VOLUME_SPIKE_THRESHOLD (6.0x) the
 *      trailing same-day 20-bar average 1-min volume. See
 *      live-darvasbox-shadow/darvas_tracker.js's fork note (4) for the full
 *      reasoning/backtest (62 real trades, 14% win rate on >=6x-spike
 *      entries vs 60-83% otherwise). Fails OPEN if there's insufficient
 *      trailing volume history yet.
 */

const { strategies } = require('./strategies');
const { istDateStr } = require('./bar_aggregator');
const darvas = strategies.find((s) => s.name === 'DarvasBox');
if (!darvas) throw new Error('DarvasBox strategy not found in strategies.js');

const EMA_FAST = 9;
const EMA_SLOW = 20;
const VOLUME_LOOKBACK_BARS = 20;
const VOLUME_MIN_TRAILING_BARS = 5;
const VOLUME_SPIKE_THRESHOLD = 6.0;

function computeEma(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { sum += closes[i]; continue; }
    if (i === period - 1) { sum += closes[i]; out[i] = sum / period; continue; }
    out[i] = closes[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

class LiveDarvasTracker {
  /**
   * @param quantity fixed order quantity for this symbol -- a deliberate choice
   *        the caller must make explicitly (this class does no capital-based
   *        sizing of its own); streamer.js currently defaults to the SAME
   *        real-holdings QUANTITIES map the paper shadow-trader already uses
   *        for P&L display, which may or may not be the right sizing rule for
   *        real order placement -- review before enabling real trading.
   * @param orderClient OrderClient instance (order_client.js)
   * @param riskManager RiskManager instance (risk_manager.js), shared across all symbols
   * @param opts.catastrophicStopPct e.g. 0.03 for 3% -- wide backstop, not the primary exit mechanism
   */
  constructor(symbol, instrumentKey, quantity, orderClient, riskManager, opts = {}) {
    this.symbol = symbol;
    this.instrumentKey = instrumentKey;
    this.quantity = quantity;
    this.orderClient = orderClient;
    this.riskManager = riskManager;
    this.catastrophicStopPct = opts.catastrophicStopPct != null ? opts.catastrophicStopPct : 0.03;
    this.position = null;
    this.processedBrickCount = 0;
    this.processedBar5Count = 0;
    this.processedBarCount = 0;
  }

  resetForNewDay() {
    this.position = null;
    this.processedBrickCount = 0;
    this.processedBar5Count = 0;
    this.processedBarCount = 0;
  }

  /**
   * bricks = ALL of today's bricks so far. Entries only -- exits are
   * checkEmaCrossExit/checkCatastrophicStop/forceEodClose. bars5 = the SAME
   * historical+today 5-min series passed to checkEmaCrossExit (defaults to
   * [], fails open -- see fork note 5). bars1m = today's raw 1-min bars
   * (defaults to [], fails open -- see fork note 6). Async: places a real
   * order on a signal.
   */
  async processBricks(bricks, bars5 = [], bars1m = []) {
    const ctx = { bricks };
    const events = [];
    const start = Math.max(1, this.processedBrickCount);
    const closes = bars5.map((b) => b.close);
    const emaFast = computeEma(closes, EMA_FAST);
    const emaSlow = computeEma(closes, EMA_SLOW);

    for (let i = start; i < bricks.length; i++) {
      if (this.position) continue; // one position at a time per symbol; never re-check entries while open
      const direction = darvas.getEntry(i, ctx);
      if (!direction) continue;
      if (!this.riskManager.canEnter()) {
        console.log(`  [${this.symbol}] Entry signal (${direction}) suppressed -- risk manager circuit breaker tripped: ${this.riskManager.trippedReason}`);
        continue;
      }
      if (!this._trendAligned(direction, bricks[i].timestampMs, bars5, emaFast, emaSlow)) continue;
      if (!this._volumeSpikeOk(direction, bricks[i].timestampMs, bricks[i].volume, bars1m)) continue;
      const event = await this._enter(direction, bricks[i]);
      if (event) events.push(event);
    }
    this.processedBrickCount = bricks.length;
    return events;
  }

  /** True if EMA9/EMA20 (as of the last 5-min bar at/before brickTimestampMs) agree with `direction`, or if no EMA data is available yet (fails open). */
  _trendAligned(direction, brickTimestampMs, bars5, emaFast, emaSlow) {
    let idx = -1;
    for (let j = 0; j < bars5.length; j++) {
      if (bars5[j].timestampMs <= brickTimestampMs) idx = j; else break;
    }
    if (idx === -1 || emaFast[idx] == null || emaSlow[idx] == null) return true;
    const aligned = direction === 'LONG' ? emaFast[idx] > emaSlow[idx] : emaFast[idx] < emaSlow[idx];
    if (!aligned) {
      console.log(`  [${this.symbol}] ${direction} box breakout at ${new Date(brickTimestampMs).toISOString()} suppressed -- EMA9 (${emaFast[idx].toFixed(3)}) vs EMA20 (${emaSlow[idx].toFixed(3)}) is counter-trend.`);
    }
    return aligned;
  }

  /** True unless the entry brick's volume is an extreme spike relative to the trailing same-day 1-min volume (fails open with insufficient history) -- see fork note (6). */
  _volumeSpikeOk(direction, brickTimestampMs, brickVolume, bars1m) {
    if (!bars1m || bars1m.length === 0) return true;
    let idx = -1;
    for (let j = 0; j < bars1m.length; j++) {
      if (bars1m[j].timestampMs <= brickTimestampMs) idx = j; else break;
    }
    if (idx === -1) return true;

    const entryDate = istDateStr(bars1m[idx].timestampMs);
    const trailing = [];
    for (let j = idx - 1; j >= 0 && trailing.length < VOLUME_LOOKBACK_BARS; j--) {
      if (istDateStr(bars1m[j].timestampMs) !== entryDate) break;
      trailing.push(bars1m[j].volume);
    }
    if (trailing.length < VOLUME_MIN_TRAILING_BARS) return true;

    const trailingAvg = trailing.reduce((a, b) => a + b, 0) / trailing.length;
    if (trailingAvg <= 0) return true;

    const spikeRatio = brickVolume / trailingAvg;
    const ok = spikeRatio < VOLUME_SPIKE_THRESHOLD;
    if (!ok) {
      console.log(`  [${this.symbol}] ${direction} box breakout at ${new Date(brickTimestampMs).toISOString()} suppressed -- entry volume ${brickVolume} is ${spikeRatio.toFixed(1)}x the trailing ${trailing.length}-bar average (${trailingAvg.toFixed(1)}) -- extreme spike, likely exhaustion not confirmation.`);
    }
    return ok;
  }

  async _enter(direction, entryBrick) {
    const transactionType = direction === 'LONG' ? 'BUY' : 'SELL';
    const qty = this.quantity;
    let orderId;
    try {
      orderId = await this.orderClient.placeOrder(this.instrumentKey, qty, transactionType);
    } catch (e) {
      console.error(`  [${this.symbol}] ENTRY order placement failed (${transactionType} qty=${qty}): ${e.message}`);
      return { type: 'ORDER_ERROR', symbol: this.symbol, phase: 'ENTRY', direction, error: e.message, timestampMs: entryBrick.timestampMs };
    }

    const fill = await this.orderClient.waitForFill(orderId);
    if (!fill || fill.status !== 'complete') {
      console.error(`  [${this.symbol}] ENTRY order ${orderId} did NOT confirm filled (status=${fill ? fill.status : 'unconfirmed'}) -- NOT tracking a position. Verify manually on Upstox.`);
      return {
        type: 'ORDER_UNCONFIRMED', symbol: this.symbol, phase: 'ENTRY', direction, orderId,
        status: fill ? fill.status : 'unconfirmed', timestampMs: entryBrick.timestampMs,
      };
    }

    const entryPrice = fill.avgPrice > 0 ? fill.avgPrice : entryBrick.close;
    const filledQty = fill.filledQty > 0 ? fill.filledQty : qty;
    const catastrophicStop = direction === 'LONG'
      ? entryPrice * (1 - this.catastrophicStopPct)
      : entryPrice * (1 + this.catastrophicStopPct);

    this.position = {
      direction, entry: entryPrice, qty: filledQty, entryOrderId: orderId,
      entryTimestampMs: entryBrick.timestampMs, catastrophicStop, exitAttemptPending: false,
    };

    console.log(`  [${this.symbol}] REAL ENTRY ${direction} qty=${filledQty} @₹${entryPrice} orderId=${orderId}`);
    return {
      type: 'ENTRY', symbol: this.symbol, direction, entry: entryPrice, qty: filledQty,
      orderId, timestampMs: entryBrick.timestampMs,
    };
  }

  /**
   * The primary exit mechanism (same 9/20 EMA math as the paper tracker).
   * bars5 = ALL of today's 5-minute bars so far (aggregate via
   * bar_aggregator.js::aggregateTo5Min before calling). Async: places a
   * real closing order on a cross.
   */
  async checkEmaCrossExit(bars5) {
    const start = Math.max(1, this.processedBar5Count);
    this.processedBar5Count = bars5.length;
    if (!this.position || this.position.exitAttemptPending) return null;

    const closes = bars5.map((b) => b.close);
    const emaFast = computeEma(closes, EMA_FAST);
    const emaSlow = computeEma(closes, EMA_SLOW);
    const pos = this.position;

    for (let i = start; i < bars5.length; i++) {
      if (bars5[i].timestampMs <= pos.entryTimestampMs) continue;
      if (emaFast[i] == null || emaSlow[i] == null || emaFast[i - 1] == null || emaSlow[i - 1] == null) continue;
      const bearishCross = emaFast[i - 1] >= emaSlow[i - 1] && emaFast[i] < emaSlow[i];
      const bullishCross = emaFast[i - 1] <= emaSlow[i - 1] && emaFast[i] > emaSlow[i];
      if ((pos.direction === 'LONG' && bearishCross) || (pos.direction === 'SHORT' && bullishCross)) {
        return this._exit('EMA_9_20_CROSS', bars5[i].timestampMs);
      }
    }
    return null;
  }

  /**
   * Backstop only -- NOT the primary exit. Checks real-time bar highs/lows
   * (same touch-based philosophy as the old paper tracker's checkIntrabarStop)
   * against a wide catastrophic-loss level. `bars` = today's 1-min bars.
   */
  async checkCatastrophicStop(bars) {
    const start = this.processedBarCount;
    this.processedBarCount = bars.length;
    if (!this.position || this.position.exitAttemptPending) return null;
    const pos = this.position;

    for (let i = start; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.timestampMs <= pos.entryTimestampMs) continue;
      const hit = pos.direction === 'LONG' ? bar.low <= pos.catastrophicStop : bar.high >= pos.catastrophicStop;
      if (hit) return this._exit('CATASTROPHIC_STOP', bar.timestampMs);
    }
    return null;
  }

  /** Called at/after 15:30 IST if a position is still open. */
  async forceEodClose() {
    if (!this.position || this.position.exitAttemptPending) return null;
    return this._exit('EOD_SQUARE_OFF', Date.now());
  }

  /** Called by streamer.js when the risk manager's daily circuit breaker trips -- squares off regardless of EMA/catastrophic state. */
  async forceCircuitBreakerSquareOff() {
    if (!this.position || this.position.exitAttemptPending) return null;
    return this._exit('CIRCUIT_BREAKER_SQUARE_OFF', Date.now());
  }

  async _exit(reason, exitTimestampMs) {
    const pos = this.position;
    const closingType = pos.direction === 'LONG' ? 'SELL' : 'BUY';
    let orderId;
    try {
      orderId = await this.orderClient.placeOrder(this.instrumentKey, pos.qty, closingType);
    } catch (e) {
      console.error(`  [${this.symbol}] EXIT (${reason}) order placement failed: ${e.message} -- position left OPEN, verify manually on Upstox.`);
      pos.exitAttemptPending = true;
      return { type: 'ORDER_ERROR', symbol: this.symbol, phase: 'EXIT', reason, error: e.message, timestampMs: exitTimestampMs };
    }

    const fill = await this.orderClient.waitForFill(orderId);
    if (!fill || fill.status !== 'complete') {
      console.error(`  [${this.symbol}] EXIT (${reason}) order ${orderId} did NOT confirm filled (status=${fill ? fill.status : 'unconfirmed'}) -- position left OPEN (exitAttemptPending), verify manually on Upstox.`);
      pos.exitAttemptPending = true;
      return {
        type: 'ORDER_UNCONFIRMED', symbol: this.symbol, phase: 'EXIT', reason, orderId,
        status: fill ? fill.status : 'unconfirmed', timestampMs: exitTimestampMs,
      };
    }

    const exitPrice = fill.avgPrice > 0 ? fill.avgPrice : pos.entry;
    const filledQty = fill.filledQty > 0 ? fill.filledQty : pos.qty;
    const pnlPct = pos.direction === 'LONG' ? ((exitPrice - pos.entry) / pos.entry) * 100 : ((pos.entry - exitPrice) / pos.entry) * 100;
    const pnlRs = pos.direction === 'LONG' ? (exitPrice - pos.entry) * filledQty : (pos.entry - exitPrice) * filledQty;

    this.position = null;
    this.riskManager.recordRealizedPnl(pnlRs);

    console.log(`  [${this.symbol}] REAL EXIT (${reason}) qty=${filledQty} @₹${exitPrice} orderId=${orderId} pnl=₹${pnlRs.toFixed(0)} (${pnlPct.toFixed(2)}%)`);
    return {
      type: 'EXIT', symbol: this.symbol, direction: pos.direction, entry: pos.entry, exitPrice,
      qty: filledQty, action: reason, pnlPct, pnlRs, entryOrderId: pos.entryOrderId, exitOrderId: orderId,
      entryTimestampMs: pos.entryTimestampMs, exitTimestampMs,
    };
  }
}

module.exports = { LiveDarvasTracker };
