'use strict';

/**
 * Per-symbol state machine for the Inside Candle Sweep+Break strategy.
 * Direct Node port of the Pine logic validated live in this session (see
 * "/Users/adilrizwan/Downloads/second brain/wiki/reference/inside-candle-next-candle-sweep-break.pine",
 * v1.2, and wiki/concepts/inside-candle-liquidity-sweep-scalp.md for the
 * source-confirmed rules).
 *
 * Rule, WITH the trend filter (default, see TREND_FILTER_ENABLED below) --
 * ported from
 * "/Users/adilrizwan/Downloads/second brain/wiki/reference/inside-candle-next-candle-trend-filtered.pine"
 * (IC-NextCandle-Trend): direction is decided by trend BEFORE the sweep
 * happens -- this is a counter-trend/reversal trade, and the sweep-then-break
 * sequence only CONFIRMS or CANCELS that pre-committed direction, it never
 * determines it:
 *   1. An inside candle forms on the 15-min timeframe (its range fully
 *      contained inside the previous 15-min candle's range).
 *   2. It only ARMS (becomes a pending setup) if its "mother" candle (the one
 *      it's inside of) sits at a swing extreme AND that extreme lines up with
 *      the current trend read: bearish trend + mother is a swing LOW ->
 *      pre-commit LONG; bullish trend + mother is a swing HIGH -> pre-commit
 *      SHORT. Location ("mother is a swing extreme") is still swingLookback-
 *      based swing structure. Trend itself is v3 (2026-08-28): simply the
 *      15m close vs an EMA (EMA_LENGTH, default 20) -- above = bullish, below
 *      = bearish. An earlier swing-ladder trend construction (HH/HL vs LH/LL)
 *      was tried and scrapped in the Pine version after live debugging showed
 *      it going stale/contradictory in ways that didn't match a naked-eye
 *      trend read -- see wiki/reference/inside-candle-liquidity-sweep-pine.md
 *      "v3" for the full story. This wiki's own codification of the source's
 *      undefined "look at the chart" trend read either way, not a decoded rule.
 *   3. Check ONLY the immediately next 15-min candle. The pre-committed
 *      direction only fires if its expected extreme sweeps FIRST and the
 *      opposite extreme then breaks, within that same next candle. If the
 *      wrong extreme sweeps first, the setup is silently cancelled.
 *   4. Target = fixed R_TARGET multiple of risk (ic_high - ic_low). Source
 *      states minimum 1:3, sometimes 1:4 -- default 3, see R_TARGET below.
 *
 * Set TREND_FILTER_ENABLED=false (env) or { trendFilterEnabled: false } to
 * fall back to the original untrended behaviour (fires whichever direction
 * the sweep order happens to produce, matching IC-NextCandle.pine exactly).
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
// Default ON: this is now the production rule, matching IC-NextCandle-Trend.pine. Set
// TREND_FILTER_ENABLED=false to run the original untrended IC-NextCandle behaviour instead.
const TREND_FILTER_ENABLED = process.env.TREND_FILTER_ENABLED !== 'false';
const SWING_LOOKBACK = Number(process.env.SWING_LOOKBACK || 5); // location only (mother-is-swing-extreme) -- see wiki/reference/inside-candle-liquidity-sweep-pine.md v3.6
const EMA_LENGTH = Number(process.env.EMA_LENGTH || 20); // trend = 15m close vs this EMA (v3, see inside-candle-next-candle-trend-filtered.pine)

class IcSymbolTracker {
  constructor(symbol, {
    entriesEnabled = true,
    trendFilterEnabled = TREND_FILTER_ENABLED,
    swingLookback = SWING_LOOKBACK,
    emaLength = EMA_LENGTH,
  } = {}) {
    this.symbol = symbol;
    this.entriesEnabled = entriesEnabled;
    this.trendFilterEnabled = trendFilterEnabled;
    this.swingLookback = swingLookback;
    this.emaLength = emaLength;
    this.m15 = []; // closed 15-min bars, oldest-first

    this.icHigh = null;
    this.icLow = null;
    this.icDirection = null; // pre-committed 'LONG'/'SHORT' when trendFilterEnabled, else null (either side can fire)
    this.pending = false; // true = the currently-forming 15m bar is "the next candle" to check
    this.sweptLow = false;
    this.sweptHigh = false;
    this.firstBarChecked = false; // true once addM1Bar has run at least once for this pending window

    // Trend state (only meaningful when trendFilterEnabled) -- v3: stateless EMA of 15m closes.
    // `ema` is the running EMA value; `trendBias` is recomputed fresh every 15m close from
    // bar.close vs `ema`, no ladders/history to fold in (see header comment for why the earlier
    // swing-ladder construction was scrapped).
    this.ema = null;
    this.trendBias = 0; // 1 = bullish (close > EMA), -1 = bearish (close < EMA), 0 = unclear (== EMA)

    this.openTrade = null; // { direction, entryPx, stopPx, targetPx, entryTs, r }
  }

  seedHistory(m15Bars) {
    this.m15 = (m15Bars || []).slice();
    // Warm up the EMA from seed history too -- without this, every process restart (Railway
    // redeploys periodically) would reset `ema` to null and cold-start the trend read from
    // scratch, needing many live bars to converge instead of picking up where it left off.
    if (this.trendFilterEnabled && this.m15.length) {
      const k = 2 / (this.emaLength + 1);
      this.ema = null;
      for (const b of this.m15) {
        this.ema = this.ema == null ? b.close : b.close * k + this.ema * (1 - k);
      }
      const lastClose = this.m15[this.m15.length - 1].close;
      this.trendBias = lastClose > this.ema ? 1 : lastClose < this.ema ? -1 : 0;
    }
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

    const isFirstBarOfWindow = !this.firstBarChecked;
    this.firstBarChecked = true;

    if (this.trendFilterEnabled && this.icDirection) {
      // Direction is pre-committed (icDirection) -- the sweep only needs to happen on the
      // EXPECTED side first; if the opposite side breaches first instead, the setup is wrong-order
      // and cancelled outright (no waiting for the expected side afterward), per
      // inside-candle-next-candle-trend-filtered.pine's debugEntryCode==2 case.
      const wantLong = this.icDirection === 'LONG';
      const breachLow = bar.low < this.icLow;
      const breachHigh = bar.high > this.icHigh;

      if (!this.sweptLow && !this.sweptHigh) {
        if (breachLow && breachHigh) {
          // Both sides on the same 1-min bar -- order genuinely ambiguous, same boundary-noise
          // handling as the untrended path below.
          if (isFirstBarOfWindow) {
            // skip this bar only, keep watching -- `pending` stays true
          } else {
            this.pending = false;
            this.icDirection = null;
          }
        } else if (wantLong && breachLow) {
          this.sweptLow = true; // expected-first side swept -- watching for the high break now
        } else if (!wantLong && breachHigh) {
          this.sweptHigh = true;
        } else if ((wantLong && breachHigh) || (!wantLong && breachLow)) {
          // Wrong side swept first for the pre-committed direction -- cancelled, per rule.
          this.pending = false;
          this.icDirection = null;
        }
      } else if (wantLong && this.sweptLow && bar.high > this.icHigh) {
        events.push(this._enter('LONG', bar));
      } else if (!wantLong && this.sweptHigh && bar.low < this.icLow) {
        events.push(this._enter('SHORT', bar));
      }
      return events;
    }

    // Untrended path (trendFilterEnabled=false, or icDirection unset): fires whichever direction
    // the sweep order happens to produce -- original IC-NextCandle behaviour.
    if (!this.sweptLow && !this.sweptHigh) {
      if (bar.low < this.icLow) this.sweptLow = true;
      if (bar.high > this.icHigh) this.sweptHigh = true;
      // Both on the exact same 1-min bar: order is genuinely ambiguous at this resolution.
      // Per the strict "one candle, sweep-then-break" rule this can't be reliably classified.
      if (this.sweptLow && this.sweptHigh) {
        this.sweptLow = false;
        this.sweptHigh = false;
        if (isFirstBarOfWindow) {
          // Ambiguous double-breach specifically on the VERY FIRST 1-min candle of the window
          // is more likely than usual to be boundary noise (a fast continuation/mini-gap
          // carried over from the last seconds of the just-closed inside candle) rather than a
          // genuine same-candle sweep-then-break. Per explicit request: skip just this one
          // candle and keep watching later candles in the same window -- `pending` stays true.
        } else {
          // Same ambiguity on any LATER 1-min candle in the window is treated as before --
          // genuinely no signal, cancel the setup rather than guess.
          this.pending = false;
        }
      }
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
    this.icDirection = null;
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
    const direction = t.direction, entryPx = t.entryPx;
    this.openTrade = null;
    return { type: 'OUTCOME', symbol: this.symbol, result, direction, entryPx, exitPx, rMultiple, closedTs: bar.timestampMs };
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
    this.icDirection = null;

    const n = this.m15.length;
    const prev = n >= 1 ? this.m15[n - 1] : null; // "mother" candle -- the one the inside candle sits inside of

    // Trend = this bar's own close vs. a running EMA of 15m closes (v3) -- update the EMA with
    // THIS bar's close first (matches Pine's ta.ema, which includes the current bar), then read
    // trendBias off it. Stateless per-bar read otherwise: no ladders, no history to fold in, so
    // (unlike the old swing-ladder version) this can safely happen before the arming decision
    // below without any self-reference concern.
    if (this.trendFilterEnabled) {
      const k = 2 / (this.emaLength + 1);
      this.ema = this.ema == null ? bar.close : bar.close * k + this.ema * (1 - k);
      this.trendBias = bar.close > this.ema ? 1 : bar.close < this.ema ? -1 : 0;
    }

    // Mother-is-swing-extreme (location only), only computed when the filter is on. Uses `prev`
    // (mother) against a trailing swingLookback window ENDING AT mother -- same high[1] vs.
    // ta.highest(high, swingLookback)[1] construction as
    // inside-candle-next-candle-trend-filtered.pine.
    let motherIsSwingHigh = false;
    let motherIsSwingLow = false;
    if (this.trendFilterEnabled && prev) {
      const winStart = Math.max(0, n - this.swingLookback);
      const window = this.m15.slice(winStart, n); // ends at prev, inclusive
      const maxHigh = Math.max(...window.map((b) => b.high));
      const minLow = Math.min(...window.map((b) => b.low));
      motherIsSwingHigh = prev.high >= maxHigh;
      motherIsSwingLow = prev.low <= minLow;
    }

    let isInside = false;
    if (prev && !this.openTrade) {
      isInside = bar.high <= prev.high && bar.low >= prev.low;
      if (isInside) {
        let armDirection = null; // null = don't arm; 'LONG'/'SHORT' = trend-gated pre-commit; undefined trend filter -> arms either way
        if (this.trendFilterEnabled) {
          if (this.trendBias === -1 && motherIsSwingLow) armDirection = 'LONG';
          else if (this.trendBias === 1 && motherIsSwingHigh) armDirection = 'SHORT';
          // else: trend/location don't line up -- this inside candle never arms, no sweep watched.
        } else {
          armDirection = 'ANY';
        }
        if (armDirection) {
          this.icHigh = bar.high;
          this.icLow = bar.low;
          this.pending = true;
          this.firstBarChecked = false;
          this.icDirection = armDirection === 'ANY' ? null : armDirection;
        }
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
      trendBias: this.trendBias, icDirection: this.icDirection, ema: this.ema,
    }];
  }
}

module.exports = { IcSymbolTracker, R_TARGET, TREND_FILTER_ENABLED, SWING_LOOKBACK, EMA_LENGTH };
