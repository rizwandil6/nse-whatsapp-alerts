'use strict';

/**
 * Incremental, per-symbol state machine for the PDH/PDL break-&-retest scalp.
 * One instance per symbol per trading day.
 *
 * Two rule-sets, chosen by `opts.variant`:
 *   • v1/v2  — the original alert-script port (default). Single trade/day.
 *   • v3     — a faithful port of the author's rewritten "Trading With Sidhant"
 *              v2 indicator: gap-day skip, failed-break void, leave-and-return,
 *              strict directional pins + proper engulfings, min candle size,
 *              2 trades/day, deactivate after 2 stop-losses, SL→cost after 2R.
 *              (~/Downloads/TWS PDHPDL Break & Retest Alerts.txt)
 * See wiki/reference/tws-pdh-pdl-pine-scripts.md.
 *
 * Feed it:
 *   setLevels(pdh, pdl, pdc)   once, at startup (prior day H/L, and close for v3 gap)
 *   onNew15mBar(bar)           each completed 15-min bar  -> may ARM / void a bias
 *   onNew5mBar(bar)            each completed 5-min bar   -> may SETUP + track outcome
 *
 * Events: ARMED · SETUP · MILESTONE(T1.5R|T2R) · OUTCOME(T3R|SL|BE|EOD) · GAP_SKIP(v3).
 * Alert-only. No orders.
 */

const {
  isHammer, isShooter, isBullishEngulfing, isBearishEngulfing, approachQuality, atr, range,
  isStrictHammer, isStrictShooter, isStrictBullEngulf, isStrictBearEngulf,
} = require('./pdhpdl_candle_patterns');

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
    this.opts = opts;
    this.v3 = opts.variant === 'v3';
    // Per-symbol override for F&O names, which must flatten ahead of the new
    // 15:15 Closing Auction Session start -- see streamer.js's pdhpdlOpts.
    this.flattenAfter = opts.flattenAfterMin != null ? opts.flattenAfterMin : FLATTEN_AFTER;
    this.pdh = null;
    this.pdl = null;
    this.pdc = null;                     // v3: prior-day close, for the gap test
    this.bias = 0;                       // 0 | 'LONG' | 'SHORT'
    this.armed = null;                   // { level, levelType, breakTs, breakClose }
    this.candles5m = [];
    this.apprTagFlags = [];              // v3: 1 if that bar tagged the level while leftLevel true
    this.trade = null;                   // current OPEN trade (null between trades)
    this.signalsToday = 0;
    this.slToday = 0;
    this.dayOpen = null;                 // v3
    this.gapDay = false;                 // v3
    this.gapPct = 0;                     // v3
    this.leftLevel = false;              // v3: has price fully left the level since the break?
    // config (v3 defaults from the author's script; overridable via opts)
    this.maxTrades = this.v3 ? (opts.maxTrades || 2) : 1;
    this.maxSLStops = this.v3 ? (opts.maxSLStops || 2) : Infinity;
    this.gapFilter = this.v3 && opts.gapFilter !== false;
    this.maxGapPct = opts.maxGapPct != null ? opts.maxGapPct : 0.5;
    this.failedBreakVoid = this.v3 && opts.failedBreakVoid !== false;
    this.requireLeftLevel = this.v3 && opts.requireLeftLevel !== false;
    this.atrLen = opts.atrLen || 14;
    this.pinLookback = opts.pinLookback || opts.lookback || 4;
    this.minRPct = opts.minRPct || 0;
  }

  setLevels(pdh, pdl, pdc = null) { this.pdh = pdh; this.pdl = pdl; this.pdc = pdc; }

  _tol() { return TICK_SIZE * (this.opts.tolTicks != null ? this.opts.tolTicks : TOL_TICKS); }
  _touch(bar, level) {
    const tol = this._tol();
    return bar.low <= level + tol && bar.high >= level - tol;
  }
  dayEligible() { return !this.gapDay && this.slToday < this.maxSLStops; }

  // ---- step 2: 15-min close beyond PDH/PDL arms (or, in v3, voids) a bias ---
  onNew15mBar(bar) {
    if (this.pdh == null || this.pdl == null) return [];
    if (this.v3 && this.gapDay) return [];
    const events = [];
    // arm — first break of the day wins; v3 also requires the day still eligible
    if (this.bias === 0 && inEntryWindow(bar.timestampMs, 15) && (!this.v3 || this.dayEligible())) {
      let armed = null;
      if (bar.close > this.pdh) armed = { bias: 'LONG', level: this.pdh, levelType: 'PDH' };
      else if (bar.close < this.pdl) armed = { bias: 'SHORT', level: this.pdl, levelType: 'PDL' };
      if (armed) {
        this.bias = armed.bias;
        this.armed = { level: armed.level, levelType: armed.levelType, breakTs: bar.timestampMs, breakClose: bar.close };
        if (this.v3) this.leftLevel = false; // a fresh break must leave-and-return before an entry
        events.push({
          type: 'ARMED', symbol: this.symbol, direction: this.bias,
          levelType: armed.levelType, level: armed.level, breakClose: bar.close, breakTs: bar.timestampMs,
          pdh: this.pdh, pdl: this.pdl,
        });
      }
    } else if (this.failedBreakVoid && this.bias !== 0) {
      // a confirmation close back through the level VOIDS the break (can re-arm later)
      const back = (this.bias === 'LONG' && bar.close < this.pdh) || (this.bias === 'SHORT' && bar.close > this.pdl);
      if (back) { this.bias = 0; this.armed = null; this.leftLevel = false; }
    }
    return events;
  }

  // ---- step 4/5: 5-min retest + trigger, then virtual outcome tracking ----
  onNew5mBar(bar) {
    this.candles5m.push(bar);
    const events = [];

    if (this.v3) {
      // gap eligibility, decided from the day's opening bar
      if (this.dayOpen == null) {
        this.dayOpen = bar.open;
        if (this.gapFilter && istMin(bar.timestampMs) === ENTRY_WINDOW_START && this.pdc != null && this.pdc > 0) {
          this.gapPct = Math.abs(bar.open - this.pdc) / this.pdc * 100;
          this.gapDay = this.gapPct >= this.maxGapPct;
        }
        if (this.gapDay) { this.apprTagFlags.push(0); return [{ type: 'GAP_SKIP', symbol: this.symbol, gapPct: this.gapPct, ts: bar.timestampMs }]; }
      }
      if (this.gapDay) { this.apprTagFlags.push(0); return events; }
      // leave-and-return + return-leg tag flag (parallel to candles5m)
      this._updateLeftLevel(bar);
      this.apprTagFlags.push(this._apprTag(bar));
    }

    const canEnter = this.bias !== 0 && !this.trade && this.signalsToday < this.maxTrades &&
      (!this.v3 || (this.dayEligible() && (!this.requireLeftLevel || this.leftLevel)));
    if (canEnter) events.push(...this._tryEnter(bar));
    if (this.trade && !this.trade.closed) events.push(...this._track(bar));
    if (this.trade && this.trade.closed) this.trade = null; // free the slot for a 2nd trade (v3)

    return events;
  }

  _updateLeftLevel(bar) {
    if (this.bias === 0 || this.leftLevel) return;
    const level = this.bias === 'LONG' ? this.pdh : this.pdl;
    const tol = this._tol();
    if ((this.bias === 'LONG' && bar.low > level + tol) || (this.bias === 'SHORT' && bar.high < level - tol)) this.leftLevel = true;
  }
  _apprTag(bar) {
    if (this.bias === 0 || !this.leftLevel) return 0;
    const level = this.bias === 'LONG' ? this.pdh : this.pdl;
    return this._touch(bar, level) ? 1 : 0;
  }

  _tryEnter(bar) {
    if (!inEntryWindow(bar.timestampMs, 5)) return [];
    const idx = this.candles5m.length - 1;
    if (idx < 1) return [];
    const prev = this.candles5m[idx - 1];
    const level = this.bias === 'LONG' ? this.pdh : this.pdl;
    const touch = this._touch(bar, level);
    const touchPrev = this._touch(prev, level);
    const atrVal = atr(this.candles5m, this.atrLen);

    let trigger = null, effRatio = null, rangeAtr = null;

    if (this.v3) {
      // no-consolidation: count tags only on the return leg (leftLevel), per Pine
      let tagSum = 0;
      for (let i = Math.max(0, idx - this.pinLookback); i < idx; i++) tagSum += (this.apprTagFlags[i] || 0);
      const tagged = tagSum >= 0.5;
      rangeAtr = atrVal > 0 ? range(bar) / atrVal : null;
      if (this.bias === 'LONG') {
        if (isStrictHammer(bar, atrVal, this.opts) && touch) {
          const q = approachQuality(this.candles5m, idx, 'LONG', tagged, this.opts);
          effRatio = q.effRatio;
          if (q.ok) trigger = 'PIN';
        }
        if (!trigger && isStrictBullEngulf(bar, prev, atrVal, this.opts) && (touch || touchPrev)) trigger = 'ENGULF';
      } else {
        if (isStrictShooter(bar, atrVal, this.opts) && touch) {
          const q = approachQuality(this.candles5m, idx, 'SHORT', tagged, this.opts);
          effRatio = q.effRatio;
          if (q.ok) trigger = 'PIN';
        }
        if (!trigger && isStrictBearEngulf(bar, prev, atrVal, this.opts) && (touch || touchPrev)) trigger = 'ENGULF';
      }
    } else {
      // v1/v2 legacy detectors
      let taggedInApproach = false;
      for (let i = Math.max(0, idx - this.pinLookback); i < idx; i++) {
        if (this._touch(this.candles5m[i], level)) { taggedInApproach = true; break; }
      }
      if (this.bias === 'LONG') {
        if (isHammer(bar) && touch) { const q = approachQuality(this.candles5m, idx, 'LONG', taggedInApproach, this.opts); effRatio = q.effRatio; if (q.ok) trigger = 'PIN'; }
        if (!trigger && isBullishEngulfing(bar, prev) && (touch || touchPrev)) trigger = 'ENGULF';
      } else {
        if (isShooter(bar) && touch) { const q = approachQuality(this.candles5m, idx, 'SHORT', taggedInApproach, this.opts); effRatio = q.effRatio; if (q.ok) trigger = 'PIN'; }
        if (!trigger && isBearishEngulfing(bar, prev) && (touch || touchPrev)) trigger = 'ENGULF';
      }
    }
    if (!trigger) return [];

    const buf = TICK_SIZE * (this.opts.slBufTicks != null ? this.opts.slBufTicks : SL_BUF_TICKS);
    const round = this.v3 ? (x) => Math.round(x / TICK_SIZE) * TICK_SIZE : (x) => x;
    const entry = bar.close;
    let sl, r, t1p5, t2, t3;
    if (this.bias === 'LONG') {
      sl = round((trigger === 'PIN' ? bar.low : Math.min(bar.low, prev.low)) - buf);
      r = entry - sl;
      t1p5 = round(entry + 1.5 * r); t2 = round(entry + 2 * r); t3 = round(entry + 3 * r);
    } else {
      sl = round((trigger === 'PIN' ? bar.high : Math.max(bar.high, prev.high)) + buf);
      r = sl - entry;
      t1p5 = round(entry - 1.5 * r); t2 = round(entry - 2 * r); t3 = round(entry - 3 * r);
    }
    const rPct = 100 * r / entry;
    const alerted = this.minRPct <= 0 || rPct >= this.minRPct; // v2 min-R gate (off under v3)
    this.trade = {
      direction: this.bias, triggerType: trigger, effRatio, rangeAtr, signalSeq: this.signalsToday + 1,
      entryTs: bar.timestampMs, entryPx: entry, sl, r, rPct, alerted, t1p5, t2, t3,
      breakTs: this.armed.breakTs, level: this.armed.level, levelType: this.armed.levelType,
      stopPx: sl, stopAtCost: false, hit1p5: false, hit2: false, mfeR: 0, maeR: 0, closed: false,
    };
    this.signalsToday += 1;
    return [{ type: 'SETUP', symbol: this.symbol, pdh: this.pdh, pdl: this.pdl, ...this.trade }];
  }

  _track(bar) {
    const s = this.trade;
    if (bar.timestampMs <= s.entryTs) return []; // entry is at THIS bar's close; track from next bar
    const events = [];
    const long = s.direction === 'LONG';

    const favPx = long ? bar.high : bar.low;
    const advPx = long ? bar.low : bar.high;
    s.mfeR = Math.max(s.mfeR, (long ? favPx - s.entryPx : s.entryPx - favPx) / s.r);
    s.maeR = Math.min(s.maeR, (long ? advPx - s.entryPx : s.entryPx - advPx) / s.r);

    const stop = s.stopPx;
    const hitSL = long ? bar.low <= stop : bar.high >= stop;
    const hitT3 = long ? bar.high >= s.t3 : bar.low <= s.t3;
    const hitT2 = long ? bar.high >= s.t2 : bar.low <= s.t2;
    const hitT1p5 = long ? bar.high >= s.t1p5 : bar.low <= s.t1p5;
    const forceFlat = istMin(bar.timestampMs) >= this.flattenAfter;

    // SL wins on any tie. A stop that has moved to cost resolves as BE (0R).
    if (hitSL) {
      this.slToday += 1; // counts toward the daily deactivation limit (v3), matching Pine
      return [this._close(s.stopAtCost ? 'BE' : 'SL', stop, bar.timestampMs, s.stopAtCost ? 0 : -1)];
    }

    if (hitT1p5 && !s.hit1p5) { s.hit1p5 = true; events.push({ type: 'MILESTONE', level: 'T1.5R', symbol: this.symbol, price: s.t1p5, ts: bar.timestampMs, signal: s }); }
    if (hitT2 && !s.hit2) {
      s.hit2 = true;
      events.push({ type: 'MILESTONE', level: 'T2R', symbol: this.symbol, price: s.t2, ts: bar.timestampMs, signal: s });
      if (this.v3) { s.stopPx = s.entryPx; s.stopAtCost = true; } // SL -> cost after T1 (=2R), per Pine
    }
    if (hitT3) { events.push(this._close('T3R', s.t3, bar.timestampMs, 3)); return events; }
    if (forceFlat) { events.push(this._close('EOD', bar.close, bar.timestampMs, (long ? bar.close - s.entryPx : s.entryPx - bar.close) / s.r)); return events; }
    return events;
  }

  _close(result, exitPx, ts, rMultiple) {
    const s = this.trade;
    s.closed = true;
    return {
      type: 'OUTCOME', result, symbol: this.symbol,
      exitPx, closedTs: ts, rMultiple, signalSeq: s.signalSeq,
      hit1p5: s.hit1p5, hit2: s.hit2, mfeR: s.mfeR, maeR: s.maeR,
      signal: s,
    };
  }

  /** Safety net: if EOD passed but no 5-min bar triggered the flatten. */
  forceEndOfDay() {
    if (this.trade && !this.trade.closed && this.candles5m.length) {
      const last = this.candles5m[this.candles5m.length - 1];
      const long = this.trade.direction === 'LONG';
      const ev = this._close('EOD', last.close, last.timestampMs, (long ? last.close - this.trade.entryPx : this.trade.entryPx - last.close) / this.trade.r);
      this.trade = null;
      return [ev];
    }
    return [];
  }
}

module.exports = { PdhPdlTracker, inEntryWindow, istMin };
