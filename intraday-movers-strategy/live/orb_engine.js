'use strict';

/**
 * Live per-symbol ORB (Opening Range Breakout) state machine — the same
 * rules as the backtested scan_orb.js, applied incrementally to real-time
 * 1-minute bars instead of historical arrays:
 *
 *   - First 15 minutes after 9:15 IST open = the Opening Range. Track high,
 *     low, and average volume across those bars.
 *   - After 9:30 IST, the first bar whose high breaks above the OR high (or
 *     low breaks below the OR low) with volume >= 30x the OR average volume
 *     triggers entry at the OR boundary. Only one trade per symbol per day.
 *   - Stop = opposite side of the opening range, capped at 2% (skip the
 *     trade entirely if the natural stop would be wider than that).
 *   - Target = 2% from entry.
 *   - From entry onward, each new bar is checked for stop/target; EOD
 *     (15:30 IST) triggers a square-off at the last seen price if neither
 *     has hit yet.
 *
 * One instance of ORBSymbolTracker per symbol. Caller feeds it 1-minute
 * bars in order via onNewBar(); it returns an array of events
 * ({type: 'ENTRY'|'EXIT', ...}) to alert on, same shape convention as
 * ema-scalp-strategy/live/live_signal_engine.js.
 */

const OR_MINUTES = 15;
const TARGET_PCT = 0.02;
const MAX_STOP_PCT = 0.02;
const VOLUME_MULT = 30;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const OR_END_MIN = MARKET_OPEN_MIN + OR_MINUTES;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

function istMinutesOfDay(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function istDateStr(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

class ORBSymbolTracker {
  constructor(symbol) {
    this.symbol = symbol;
    this._resetDay(null);
  }

  _resetDay(dateStr) {
    this.currentDate = dateStr;
    this.orBars = [];
    this.orHigh = null;
    this.orLow = null;
    this.avgORVolume = null;
    this.orComplete = false;
    this.position = null; // { direction, entry, stop, target }
    this.tradedToday = false;
  }

  /** bar: {timestampMs, open, high, low, close, volume}. Returns events array. */
  onNewBar(bar) {
    const events = [];
    const dateStr = istDateStr(bar.timestampMs);
    if (dateStr !== this.currentDate) {
      // New trading day (or first bar ever) — if a position was still open
      // when the day rolled over, force-close it at the last known price
      // (shouldn't normally happen if EOD square-off fires first, but this
      // is a safety net against a missed/late final bar).
      if (this.position) {
        events.push(this._closePosition('EOD_SQUARE_OFF', this._lastPrice));
      }
      this._resetDay(dateStr);
    }

    const minutesOfDay = istMinutesOfDay(bar.timestampMs);
    this._lastPrice = bar.close;

    // Still building the opening range.
    if (minutesOfDay >= MARKET_OPEN_MIN && minutesOfDay < OR_END_MIN) {
      this.orBars.push(bar);
      return events;
    }

    // Opening range just completed — compute high/low/avg volume once.
    if (!this.orComplete && minutesOfDay >= OR_END_MIN) {
      if (this.orBars.length > 0) {
        this.orHigh = Math.max(...this.orBars.map((c) => c.high));
        this.orLow = Math.min(...this.orBars.map((c) => c.low));
        this.avgORVolume = this.orBars.reduce((s, c) => s + c.volume, 0) / this.orBars.length;
      }
      this.orComplete = true;
    }

    if (!this.orComplete || this.orHigh == null) return events; // no usable OR data today

    // Already in a position — check for stop/target/EOD.
    if (this.position) {
      const { direction, stop, target } = this.position;
      const hitStop = direction === 'LONG' ? bar.low <= stop : bar.high >= stop;
      const hitTarget = direction === 'LONG' ? bar.high >= target : bar.low <= target;
      if (hitStop) {
        events.push(this._closePosition('STOP_LOSS', stop));
      } else if (hitTarget) {
        events.push(this._closePosition('TARGET_HIT', target));
      } else if (minutesOfDay >= MARKET_CLOSE_MIN) {
        events.push(this._closePosition('EOD_SQUARE_OFF', bar.close));
      }
      return events;
    }

    // No position yet today, and haven't already traded — look for a
    // volume-confirmed breakout.
    if (this.tradedToday) return events;
    if (minutesOfDay >= MARKET_CLOSE_MIN) return events; // day's over, no new entries

    const volumeThreshold = this.avgORVolume * VOLUME_MULT;
    const brokeUp = bar.high > this.orHigh;
    const brokeDown = bar.low < this.orLow;
    if (brokeUp && brokeDown) return events; // ambiguous single bar, skip per backtest convention

    let direction = null;
    if (brokeUp && bar.volume >= volumeThreshold) direction = 'LONG';
    else if (brokeDown && bar.volume >= volumeThreshold) direction = 'SHORT';
    if (!direction) return events;

    const entry = direction === 'LONG' ? this.orHigh : this.orLow;
    const stop = direction === 'LONG' ? this.orLow : this.orHigh;
    const stopPct = Math.abs(entry - stop) / entry;
    if (stopPct > MAX_STOP_PCT) {
      this.tradedToday = true; // one qualifying breakout attempt per day, even if skipped
      return events;
    }
    const target = direction === 'LONG' ? entry * (1 + TARGET_PCT) : entry * (1 - TARGET_PCT);

    this.position = { direction, entry, stop, target, entryTimestampMs: bar.timestampMs };
    this.tradedToday = true;
    // tbq/tsq (order-book buy/sell quantity at breakout) is logged only,
    // not used to gate entry — see streamer.js's extractOneMinCandles for
    // why, and the discussion in chat history for the eventual plan to
    // evaluate whether it correlates with which breakouts stop out.
    const obImbalance =
      bar.tbq != null && bar.tsq != null && bar.tbq + bar.tsq > 0 ? bar.tbq / (bar.tbq + bar.tsq) : null;
    events.push({
      type: 'ENTRY',
      symbol: this.symbol,
      direction,
      entry,
      stop,
      target,
      volumeRatio: bar.volume / this.avgORVolume,
      tbq: bar.tbq ?? null,
      tsq: bar.tsq ?? null,
      obImbalance,
    });
    return events;
  }

  _closePosition(action, exitPrice) {
    const { direction, entry, stop, target } = this.position;
    const pnlPct = direction === 'LONG' ? ((exitPrice - entry) / entry) * 100 : ((entry - exitPrice) / entry) * 100;
    const event = { type: 'EXIT', symbol: this.symbol, direction, entry, stop, target, action, exitPrice, pnlPct };
    this.position = null;
    return event;
  }
}

module.exports = { ORBSymbolTracker, OR_MINUTES, TARGET_PCT, MAX_STOP_PCT, VOLUME_MULT };
