'use strict';

/**
 * Incremental, per-symbol state machine for the PDH/PDL break-&-retest scalp.
 * One instance per symbol per trading day. Faithful to the Pine v6 ALERT
 * indicator (the stricter script) — see wiki/reference/tws-pdh-pdl-pine-scripts.md
 * and wiki/concepts/pdh-pdl-break-retest-scalp.md.
 *
 * Feed it:
 *   setLevels(pdh, pdl)   once, at startup (prior trading day's H/L)
 *   onNew15mBar(bar)      each completed 15-min bar  -> may ARM a bias
 *   onNew5mBar(bar)       each completed 5-min bar   -> may SETUP + track outcome
 *
 * Returns an array of events per call:
 *   { type:'ARMED',    ... }
 *   { type:'SETUP',    ... }              (the tradeable signal)
 *   { type:'MILESTONE', level:'T1.5R'|'T2R', ... }   (non-terminal)
 *   { type:'OUTCOME',  result:'T3R'|'SL'|'EOD', ... } (terminal)
 *
 * Alert-only. No orders. Milestone/outcome tracking is virtual, off the
 * 5-min bar stream, so it can be reconciled against Postgres later.
 */

const {
  isHammer, isShooter, isBullishEngulfing, isBearishEngulfing, approachQuality,
} = require('./candle_patterns');

const IST_OFFSET_MS = 5.5 * 3600000;
const ENTRY_WINDOW_START = 9 * 60 + 15;  // 09:15
const ENTRY_WINDOW_END = 11 * 60 + 45;   // 11:45  (first 2.5h)
const FLATTEN_AFTER = 15 * 60 + 15;      // 15:15  -> force-flat any open virtual trade

const TICK_SIZE = 0.05;                  // NSE equity tick
const SL_BUF_TICKS = 2;
const TOL_TICKS = 0;                     // exact touch required (Pine default)

function istMin(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
/**
 * A break/entry is CONFIRMED at the bar's CLOSE, so gate on close time, not
 * open time. `ms` is the bar's start (window-anchored); the bar closes
 * `sizeMin` minutes later. Valid if it opens at/after 09:15 and closes by 11:45.
 */
function inEntryWindow(ms, sizeMin) {
  const openMin = istMin(ms);
  return openMin >= ENTRY_WINDOW_START && openMin + sizeMin <= ENTRY_WINDOW_END;
}

class PdhPdlTracker {
  constructor(symbol, opts = {}) {
    this.symbol = symbol;
    this.opts = opts;                    // one-shot filter knobs (see candle_patterns.approachQuality)
    this.pdh = null;
    this.pdl = null;
    this.bias = 0;                       // 0 | 'LONG' | 'SHORT'
    this.armed = null;                   // { level, levelType, breakTs, breakClose }
    this.candles5m = [];
    this.signal = null;                  // the SETUP
    this.hit1p5 = false;
    this.hit2 = false;
    this.mfeR = 0;                       // max favourable excursion, in R
    this.maeR = 0;                       // max adverse excursion, in R
    this.closed = false;
  }

  setLevels(pdh, pdl) { this.pdh = pdh; this.pdl = pdl; }

  _touch(bar, level) {
    const tol = TICK_SIZE * TOL_TICKS;
    return bar.low <= level + tol && bar.high >= level - tol;
  }

  // ---- step 2: 15-min close beyond PDH/PDL arms a bias ---------------------
  onNew15mBar(bar) {
    if (this.bias !== 0 || this.pdh == null || this.pdl == null) return [];
    if (!inEntryWindow(bar.timestampMs, 15)) return []; // 15m break must close inside the window
    let armed = null;
    if (bar.close > this.pdh) armed = { bias: 'LONG', level: this.pdh, levelType: 'PDH' };
    else if (bar.close < this.pdl) armed = { bias: 'SHORT', level: this.pdl, levelType: 'PDL' };
    if (!armed) return [];
    this.bias = armed.bias;
    this.armed = { level: armed.level, levelType: armed.levelType, breakTs: bar.timestampMs, breakClose: bar.close };
    return [{
      type: 'ARMED', symbol: this.symbol, direction: this.bias,
      levelType: armed.levelType, level: armed.level, breakClose: bar.close, breakTs: bar.timestampMs,
      pdh: this.pdh, pdl: this.pdl,
    }];
  }

  // ---- step 4/5: 5-min retest + trigger, then virtual outcome tracking ----
  onNew5mBar(bar) {
    this.candles5m.push(bar);
    const events = [];

    if (this.bias !== 0 && !this.signal) events.push(...this._tryEnter(bar));
    if (this.signal && !this.closed) events.push(...this._track(bar));

    return events;
  }

  _tryEnter(bar) {
    if (!inEntryWindow(bar.timestampMs, 5)) return []; // 5m entry must close inside the window
    const idx = this.candles5m.length - 1;
    if (idx < 1) return [];
    const prev = this.candles5m[idx - 1];
    const level = this.bias === 'LONG' ? this.pdh : this.pdl;

    const touch = this._touch(bar, level);
    const touchPrev = this._touch(prev, level);

    // did price already tag the level during the approach window (for one-shot test)?
    const lookback = this.opts.lookback || 4;
    let taggedInApproach = false;
    for (let i = Math.max(0, idx - lookback); i < idx; i++) {
      if (this._touch(this.candles5m[i], level)) { taggedInApproach = true; break; }
    }

    let trigger = null, effRatio = null;
    if (this.bias === 'LONG') {
      if (isHammer(bar) && touch) {
        const q = approachQuality(this.candles5m, idx, 'LONG', taggedInApproach, this.opts);
        effRatio = q.effRatio;
        if (q.ok) trigger = 'PIN';
      }
      if (!trigger && isBullishEngulfing(bar, prev) && (touch || touchPrev)) trigger = 'ENGULF';
    } else {
      if (isShooter(bar) && touch) {
        const q = approachQuality(this.candles5m, idx, 'SHORT', taggedInApproach, this.opts);
        effRatio = q.effRatio;
        if (q.ok) trigger = 'PIN';
      }
      if (!trigger && isBearishEngulfing(bar, prev) && (touch || touchPrev)) trigger = 'ENGULF';
    }
    if (!trigger) return [];

    const buf = TICK_SIZE * SL_BUF_TICKS;
    const entry = bar.close;
    let sl, r, t1p5, t2, t3;
    if (this.bias === 'LONG') {
      sl = (trigger === 'PIN' ? bar.low : Math.min(bar.low, prev.low)) - buf;
      r = entry - sl;
      t1p5 = entry + 1.5 * r; t2 = entry + 2 * r; t3 = entry + 3 * r;
    } else {
      sl = (trigger === 'PIN' ? bar.high : Math.max(bar.high, prev.high)) + buf;
      r = sl - entry;
      t1p5 = entry - 1.5 * r; t2 = entry - 2 * r; t3 = entry - 3 * r;
    }
    this.signal = {
      direction: this.bias, triggerType: trigger, effRatio,
      entryTs: bar.timestampMs, entryPx: entry, sl, r, t1p5, t2, t3,
      breakTs: this.armed.breakTs, level: this.armed.level, levelType: this.armed.levelType,
    };
    return [{ type: 'SETUP', symbol: this.symbol, pdh: this.pdh, pdl: this.pdl, ...this.signal }];
  }

  _track(bar) {
    const s = this.signal;
    if (bar.timestampMs <= s.entryTs) return []; // entry is at THIS bar's close; track from next bar
    const events = [];
    const long = s.direction === 'LONG';

    // excursions (in R)
    const favPx = long ? bar.high : bar.low;
    const advPx = long ? bar.low : bar.high;
    this.mfeR = Math.max(this.mfeR, (long ? favPx - s.entryPx : s.entryPx - favPx) / s.r);
    this.maeR = Math.min(this.maeR, (long ? advPx - s.entryPx : s.entryPx - advPx) / s.r);

    const hitSL = long ? bar.low <= s.sl : bar.high >= s.sl;
    const hitT3 = long ? bar.high >= s.t3 : bar.low <= s.t3;
    const hitT2 = long ? bar.high >= s.t2 : bar.low <= s.t2;
    const hitT1p5 = long ? bar.high >= s.t1p5 : bar.low <= s.t1p5;
    const forceFlat = istMin(bar.timestampMs) >= FLATTEN_AFTER;

    // conservative: if SL and a target are both touched in the same bar, treat SL first.
    if (hitSL) return [...events, this._close('SL', s.sl, bar.timestampMs, -1)];

    if (hitT1p5 && !this.hit1p5) {
      this.hit1p5 = true;
      events.push({ type: 'MILESTONE', level: 'T1.5R', symbol: this.symbol, price: s.t1p5, ts: bar.timestampMs, signal: s });
    }
    if (hitT2 && !this.hit2) {
      this.hit2 = true;
      events.push({ type: 'MILESTONE', level: 'T2R', symbol: this.symbol, price: s.t2, ts: bar.timestampMs, signal: s });
    }
    if (hitT3) { events.push(this._close('T3R', s.t3, bar.timestampMs, 3)); return events; }
    if (forceFlat) { events.push(this._close('EOD', bar.close, bar.timestampMs, (long ? bar.close - s.entryPx : s.entryPx - bar.close) / s.r)); return events; }
    return events;
  }

  _close(result, exitPx, ts, rMultiple) {
    this.closed = true;
    return {
      type: 'OUTCOME', result, symbol: this.symbol,
      exitPx, closedTs: ts, rMultiple,
      hit1p5: this.hit1p5, hit2: this.hit2, mfeR: this.mfeR, maeR: this.maeR,
      signal: this.signal,
    };
  }

  /** Safety net: if EOD passed but no 5-min bar triggered the flatten. */
  forceEndOfDay() {
    if (this.signal && !this.closed && this.candles5m.length) {
      const last = this.candles5m[this.candles5m.length - 1];
      const long = this.signal.direction === 'LONG';
      return [this._close('EOD', last.close, last.timestampMs, (long ? last.close - this.signal.entryPx : this.signal.entryPx - last.close) / this.signal.r)];
    }
    return [];
  }
}

module.exports = { PdhPdlTracker, inEntryWindow, istMin };
