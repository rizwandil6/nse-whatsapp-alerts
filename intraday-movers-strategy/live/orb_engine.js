'use strict';

/**
 * Live per-symbol ORB (Opening Range Breakout) state machine, upgraded
 * with 3 validated Bollinger-Bands-strategy concepts (see
 * intraday-movers-strategy/scan_orb_bb_enhanced.js for the 60-day
 * backtest that validated this exact combination — 526 trades, 77.8%
 * net win, +0.699% net avg P&L, vs. the original fixed-target version's
 * 62.8%/+0.433%):
 *
 *   - First 15 minutes after 9:15 IST open = the Opening Range. Track high,
 *     low, and average volume across those bars.
 *   - After 9:30 IST, the first bar whose high breaks above the OR high (or
 *     low breaks below the OR low) with volume >= 30x the OR average volume
 *     AND price above VWAP (LONG) / below VWAP (SHORT) AND price above the
 *     Bollinger middle band / 20 SMA (LONG) / below it (SHORT) triggers
 *     entry at the OR boundary. Only one trade per symbol per day. Needs
 *     >=20 bars of close history for a valid Bollinger Band before any
 *     entry can fire (typically ready ~9:35 IST) — see the backtest for
 *     why this doesn't meaningfully cost trade count.
 *   - No new entries after 15:15 IST -- too little of the session left
 *     for a band-hugging exit to have room to run.
 *   - Stop = opposite side of the opening range, capped at 2% (skip the
 *     trade entirely if the natural stop would be wider than that).
 *   - NO FIXED TARGET. Exit is "band hugging": once price has touched the
 *     outer Bollinger Band (upper for LONG, lower for SHORT), stay in as
 *     long as each subsequent bar still reaches (within a small tolerance
 *     of) that band; exit the moment a bar fails to — "creates distance"
 *     from the band, i.e. the move has stalled. This is what let winners
 *     run in the backtest instead of capping at a fixed 2%.
 *   - EOD (15:30 IST) triggers a square-off at the last seen price if
 *     nothing else has closed the position yet.
 *
 * One instance of ORBSymbolTracker per symbol. Caller feeds it 1-minute
 * bars in order via onNewBar(); it returns an array of events
 * ({type: 'ENTRY'|'EXIT', ...}) to alert on, same shape convention as
 * ema-scalp-strategy/live/live_signal_engine.js.
 */

const OR_MINUTES = 15;
const MAX_STOP_PCT = 0.02;
const VOLUME_MULT = 30;
const BB_PERIOD = 20;
const BB_STDDEV_MULT = 2;
const BB_TOUCH_TOLERANCE_PCT = 0.001; // within 0.1% of the band counts as "touching" — same value validated in the backtest
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const OR_END_MIN = MARKET_OPEN_MIN + OR_MINUTES;
const MARKET_CLOSE_MIN = 15 * 60 + 30;
const ENTRY_CUTOFF_MIN = 15 * 60 + 15; // no new entries after 15:15 IST -- too little of the session left to let a band-hugging exit run

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
    this.position = null; // { direction, entry, stop, hasHuggedBand }
    this.tradedToday = false;
    this.cumulativePV = 0; // VWAP accumulators, reset daily
    this.cumulativeV = 0;
    this.closeHistory = []; // rolling window for Bollinger Bands, reset daily
  }

  /** bar: {timestampMs, open, high, low, close, volume, tbq, tsq}. Returns events array. */
  onNewBar(bar) {
    const events = [];
    const dateStr = istDateStr(bar.timestampMs);
    if (dateStr !== this.currentDate) {
      // New trading day (or first bar ever) — if a position was still open
      // when the day rolled over, force-close it at the last known price
      // (shouldn't normally happen if EOD square-off fires first, but this
      // is a safety net against a missed/late final bar).
      if (this.position) {
        events.push(this._closePosition('EOD_SQUARE_OFF', this._lastPrice, bar.timestampMs));
      }
      this._resetDay(dateStr);
    }

    const minutesOfDay = istMinutesOfDay(bar.timestampMs);
    this._lastPrice = bar.close;

    // VWAP accumulation — every bar, all day, typical-price convention.
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    this.cumulativePV += typicalPrice * bar.volume;
    this.cumulativeV += bar.volume;
    const vwap = this.cumulativeV > 0 ? this.cumulativePV / this.cumulativeV : null;

    // Bollinger Bands — 20-period SMA +/- 2 stddev on the rolling close window.
    this.closeHistory.push(bar.close);
    if (this.closeHistory.length > BB_PERIOD) this.closeHistory.shift();
    let bbMiddle = null;
    let bbUpper = null;
    let bbLower = null;
    if (this.closeHistory.length === BB_PERIOD) {
      const sma = this.closeHistory.reduce((s, c) => s + c, 0) / BB_PERIOD;
      const variance = this.closeHistory.reduce((s, c) => s + (c - sma) ** 2, 0) / BB_PERIOD;
      const stddev = Math.sqrt(variance);
      bbMiddle = sma;
      bbUpper = sma + BB_STDDEV_MULT * stddev;
      bbLower = sma - BB_STDDEV_MULT * stddev;
    }

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

    // Already in a position — check for stop / band-distance exit / EOD.
    if (this.position) {
      const { direction, stop } = this.position;
      const hitStop = direction === 'LONG' ? bar.low <= stop : bar.high >= stop;
      if (hitStop) {
        events.push(this._closePosition('STOP_LOSS', stop, bar.timestampMs));
        return events;
      }

      if (bbUpper != null) {
        const outerBand = direction === 'LONG' ? bbUpper : bbLower;
        const tolerance = Math.abs(outerBand) * BB_TOUCH_TOLERANCE_PCT;
        const touchingNow = direction === 'LONG' ? bar.high >= outerBand - tolerance : bar.low <= outerBand + tolerance;
        if (touchingNow) {
          this.position.hasHuggedBand = true;
        } else if (this.position.hasHuggedBand) {
          // was hugging the band, this bar failed to reach it -> "created distance", exit
          events.push(this._closePosition('BAND_DISTANCE_EXIT', bar.close, bar.timestampMs));
          return events;
        }
      }

      if (minutesOfDay >= MARKET_CLOSE_MIN) {
        events.push(this._closePosition('EOD_SQUARE_OFF', bar.close, bar.timestampMs));
      }
      return events;
    }

    // No position yet today, and haven't already traded — look for a
    // volume-confirmed breakout with VWAP + Bollinger trend confirmation.
    if (this.tradedToday) return events;
    if (minutesOfDay >= ENTRY_CUTOFF_MIN) return events; // no new entries after 15:15 IST
    if (bbMiddle == null) return events; // not enough close history yet for a valid Bollinger middle band (~9:35 IST)

    const volumeThreshold = this.avgORVolume * VOLUME_MULT;
    const brokeUp = bar.high > this.orHigh;
    const brokeDown = bar.low < this.orLow;
    if (brokeUp && brokeDown) return events; // ambiguous single bar, skip per backtest convention

    let direction = null;
    if (brokeUp && bar.volume >= volumeThreshold && vwap != null && bar.close > vwap && bar.close > bbMiddle) {
      direction = 'LONG';
    } else if (brokeDown && bar.volume >= volumeThreshold && vwap != null && bar.close < vwap && bar.close < bbMiddle) {
      direction = 'SHORT';
    }
    if (!direction) return events;

    const entry = direction === 'LONG' ? this.orHigh : this.orLow;
    const stop = direction === 'LONG' ? this.orLow : this.orHigh;
    const stopPct = Math.abs(entry - stop) / entry;
    if (stopPct > MAX_STOP_PCT) {
      this.tradedToday = true; // one qualifying breakout attempt per day, even if skipped
      return events;
    }

    // tbq/tsq (order-book buy/sell quantity at breakout) is logged only,
    // not used to gate entry — see the earlier chat discussion for the
    // eventual plan to evaluate whether it correlates with outcomes.
    const obImbalance =
      bar.tbq != null && bar.tsq != null && bar.tbq + bar.tsq > 0 ? bar.tbq / (bar.tbq + bar.tsq) : null;

    this.position = {
      direction,
      entry,
      stop,
      entryTimestampMs: bar.timestampMs,
      hasHuggedBand: false,
      tbq: bar.tbq ?? null,
      tsq: bar.tsq ?? null,
      obImbalance,
    };
    this.tradedToday = true;
    events.push({
      type: 'ENTRY',
      symbol: this.symbol,
      direction,
      entry,
      stop,
      volumeRatio: bar.volume / this.avgORVolume,
      vwap,
      bbMiddle,
      bbUpper,
      bbLower,
      tbq: bar.tbq ?? null,
      tsq: bar.tsq ?? null,
      obImbalance,
      entryTimestampMs: bar.timestampMs,
    });
    return events;
  }

  _closePosition(action, exitPrice, exitTimestampMs) {
    const { direction, entry, stop, tbq, tsq, obImbalance, entryTimestampMs } = this.position;
    const pnlPct = direction === 'LONG' ? ((exitPrice - entry) / entry) * 100 : ((entry - exitPrice) / entry) * 100;
    const event = {
      type: 'EXIT',
      symbol: this.symbol,
      direction,
      entry,
      stop,
      action,
      exitPrice,
      pnlPct,
      tbq,
      tsq,
      obImbalance,
      entryTimestampMs,
      exitTimestampMs: exitTimestampMs ?? entryTimestampMs,
    };
    this.position = null;
    return event;
  }
}

module.exports = { ORBSymbolTracker, OR_MINUTES, MAX_STOP_PCT, VOLUME_MULT, BB_PERIOD, BB_STDDEV_MULT, MARKET_OPEN_MIN, OR_END_MIN };
