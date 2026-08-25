'use strict';

/**
 * Per-symbol state machine for the Inside Candle Sweep+Break strategy.
 * Direct Node port of the Pine logic validated live in this session (see
 * "/Users/adilrizwan/Downloads/second brain/wiki/reference/inside-candle-next-candle-sweep-break.pine",
 * v1.2, and wiki/concepts/inside-candle-liquidity-sweep-scalp.md for the
 * source-confirmed rules).
 *
 * Rule (no trend/structure filter -- deliberately the simplified version the
 * user confirmed "looks convincing," matching IC-NextCandle.pine exactly,
 * not the fuller IC-Sweep.pine with trend/structure gates):
 *   1. An inside candle forms on the 15-min timeframe (its range fully
 *      contained inside the previous 15-min candle's range).
 *   2. Check ONLY the immediately next 15-min candle. Within that one
 *      candle: if the low sweeps first (breaches ic_low) and THEN the high
 *      breaks (exceeds ic_high) -- LONG, entry = ic_high, stop = ic_low.
 *      Mirror for SHORT (high sweeps first, then low breaks).
 *   3. If the next candle does only one of the two, or neither, or breaks
 *      the wrong side first -- no signal. Not tracked further; wait for the
 *      next inside candle.
 *   4. Target = fixed R_TARGET multiple of risk (ic_high - ic_low). Source
 *      states minimum 1:3, sometimes 1:4 -- default 3, see R_TARGET below.
 *
 * WHICH side happened first within the single next 15-min candle requires
 * sub-candle resolution -- this engine gets that by being fed 1-minute bars
 * in real time via addM1Bar() WHILE the "next candle" window is open,
 * exactly mirroring how the Pine version uses request.security_lower_tf()
 * for the same purpose. addM15Bar() only ever does two things: (a) close out
 * an unresolved pending window (one-shot, per rule 3), (b) check whether the
 * just-closed 15m bar is a NEW qualifying inside candle for the next window.
 *
 * Alert-only. This file makes zero authenticated Pi42 requests and contains
 * no order-placement code -- same boundary as ichimoku-btc-xau-strategy.
 */

const R_TARGET = Number(process.env.R_TARGET || 3); // fixed R-multiple, source states min 1:3 (sometimes 1:4)

class IcSymbolTracker {
  constructor(symbol, { entriesEnabled = true } = {}) {
    this.symbol = symbol;
    this.entriesEnabled = entriesEnabled;
    this.m15 = []; // closed 15-min bars, oldest-first

    this.icHigh = null;
    this.icLow = null;
    this.pending = false; // true = the currently-forming 15m bar is "the next candle" to check
    this.sweptLow = false;
    this.sweptHigh = false;

    this.openTrade = null; // { direction, entryPx, stopPx, targetPx, entryTs, r }
  }

  seedHistory(m15Bars) {
    this.m15 = (m15Bars || []).slice();
  }

  /** Restart resilience: reattach a still-OPEN position from Postgres (see db.js#getOpenSignal). */
  resumeTrade(row) {
    this.openTrade = {
      direction: row.direction,
      entryPx: Number(row.entry_px),
      stopPx: Number(row.stop_px),
      targetPx: Number(row.target_px),
      entryTs: new Date(row.entry_ts).getTime(),
      r: Number(row.r_value),
    };
    return [];
  }

  /** Called every time a 1-minute bar completes, in real time, while price moves. */
  addM1Bar(bar) {
    const events = [];
    if (this.openTrade) {
      const e = this._checkOpenTrade(bar);
      if (e) events.push(e);
      return events;
    }
    if (!this.pending || !this.entriesEnabled) return events;

    if (!this.sweptLow && !this.sweptHigh) {
      if (bar.low < this.icLow) this.sweptLow = true;
      if (bar.high > this.icHigh) this.sweptHigh = true;
      // Both on the exact same 1-min bar: order is genuinely ambiguous at this resolution.
      // Per the strict "one candle, sweep-then-break" rule this can't be reliably classified,
      // so it's treated as no signal rather than guessing -- rare in practice (a 1-min bar
      // wide enough to span both an entire 15m candle's high and low).
      if (this.sweptLow && this.sweptHigh) { this.sweptLow = false; this.sweptHigh = false; this.pending = false; }
    } else if (this.sweptLow && !this.sweptHigh && bar.high > this.icHigh) {
      events.push(this._enter('LONG', bar));
    } else if (this.sweptHigh && !this.sweptLow && bar.low < this.icLow) {
      events.push(this._enter('SHORT', bar));
    }
    return events;
  }

  _enter(direction, bar) {
    const risk = this.icHigh - this.icLow;
    const entryPx = direction === 'LONG' ? this.icHigh : this.icLow;
    const stopPx = direction === 'LONG' ? this.icLow : this.icHigh;
    const targetPx = direction === 'LONG' ? entryPx + risk * R_TARGET : entryPx - risk * R_TARGET;
    this.openTrade = { direction, entryPx, stopPx, targetPx, entryTs: bar.timestampMs, r: risk };
    this.pending = false;
    this.sweptLow = false;
    this.sweptHigh = false;
    return {
      type: 'SETUP', symbol: this.symbol, direction, entryPx, stop: stopPx, target: targetPx,
      r: risk, entryTs: bar.timestampMs, icHigh: this.icHigh, icLow: this.icLow,
    };
  }

  _checkOpenTrade(bar) {
    const t = this.openTrade;
    if (!t) return null;
    let result = null, exitPx = null;
    if (t.direction === 'LONG') {
      if (bar.low <= t.stopPx) { result = 'SL'; exitPx = t.stopPx; }
      else if (bar.high >= t.targetPx) { result = 'TARGET'; exitPx = t.targetPx; }
    } else {
      if (bar.high >= t.stopPx) { result = 'SL'; exitPx = t.stopPx; }
      else if (bar.low <= t.targetPx) { result = 'TARGET'; exitPx = t.targetPx; }
    }
    if (!result) return null;
    const rMultiple = result === 'TARGET' ? R_TARGET : -1;
    this.openTrade = null;
    return { type: 'OUTCOME', symbol: this.symbol, result, exitPx, rMultiple, closedTs: bar.timestampMs };
  }

  /** Called every time a 15-minute bar CLOSES. */
  addM15Bar(bar) {
    // Rule 3: only the immediately next candle counts -- if we reach a new 15m close without
    // having fired (addM1Bar would have already cleared `pending` if it fired), the window is
    // over, one-shot, no re-check on a later candle.
    const wasPending = this.pending;
    this.pending = false;
    this.sweptLow = false;
    this.sweptHigh = false;

    let isInside = false;
    const n = this.m15.length;
    if (n >= 1 && !this.openTrade) {
      const prev = this.m15[n - 1];
      isInside = bar.high <= prev.high && bar.low >= prev.low;
      if (isInside) {
        this.icHigh = bar.high;
        this.icLow = bar.low;
        this.pending = true;
      }
    }
    this.m15.push(bar);
    // Console-only liveness/diagnostic signal (never Telegram, never Postgres) -- added after
    // deploying with zero per-bar logging made it impossible to tell "quiet, no signal yet" apart
    // from "silently stuck," same problem ichimoku-btc-xau-strategy's README describes hitting
    // and fixing the same way (fmtDiagnostic there, this event here).
    return [{
      type: 'DIAGNOSTIC', symbol: this.symbol, ts: bar.timestampMs, close: bar.close,
      wasPendingUnresolved: wasPending, isInside, nowPending: this.pending,
      icHigh: this.icHigh, icLow: this.icLow, openTrade: !!this.openTrade,
    }];
  }
}

module.exports = { IcSymbolTracker, R_TARGET };
