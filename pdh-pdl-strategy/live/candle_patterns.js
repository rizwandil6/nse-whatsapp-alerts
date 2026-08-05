'use strict';

/**
 * Candle-shape + "no-consolidation" detectors for the PDH/PDL break-&-retest
 * scalp. These are a faithful JS port of the Pine v6 ALERT indicator shipped
 * with the source video (TWS_PDH_PDL_Alerts.pine) — the stricter of the two
 * scripts — decoded in the vault at
 * wiki/reference/tws-pdh-pdl-pine-scripts.md.
 *
 * Defaults mirror the Pine inputs: wickMult 2.0, minEff 0.55,
 * minRangeATR 1.2, pinLookback 4, atrLen 14.
 */

// ---- basic candle geometry -------------------------------------------------
// EPS absorbs float noise at exact-equality boundaries — NSE prices are
// multiples of 0.05, so a wick can genuinely equal a body, yet subtracting
// four-digit prices (3201.1 - 3200.9) rarely lands on an exact 0.2. EPS keeps
// those legitimate at-the-boundary candles from being misclassified.
const EPS = 1e-9;

function body(c) { return Math.abs(c.close - c.open); }
function upperWick(c) { return c.high - Math.max(c.open, c.close); }
function lowerWick(c) { return Math.min(c.open, c.close) - c.low; }
function range(c) { return c.high - c.low; }

/** Hammer: long lower wick >= wickMult*body, small upper wick <= body. */
function isHammer(c, wickMult = 2.0) {
  return range(c) > 0 && body(c) > 0 && lowerWick(c) >= wickMult * body(c) - EPS && upperWick(c) <= body(c) + EPS;
}
/** Shooting star / bearish pin: long upper wick, small lower wick. */
function isShooter(c, wickMult = 2.0) {
  return range(c) > 0 && body(c) > 0 && upperWick(c) >= wickMult * body(c) - EPS && lowerWick(c) <= body(c) + EPS;
}

/** Bullish engulfing: up candle whose body engulfs a prior down candle's body. */
function isBullishEngulfing(c, prev, strict = false) {
  if (!(c.close > c.open && prev.close < prev.open)) return false;
  if (strict && !(c.high >= prev.high - EPS && c.low <= prev.low + EPS)) return false;
  return c.close >= prev.open - EPS && c.open <= prev.close + EPS;
}
/** Bearish engulfing: down candle whose body engulfs a prior up candle's body. */
function isBearishEngulfing(c, prev, strict = false) {
  if (!(c.close < c.open && prev.close > prev.open)) return false;
  if (strict && !(c.high >= prev.high - EPS && c.low <= prev.low + EPS)) return false;
  return c.close <= prev.open + EPS && c.open >= prev.close - EPS;
}

// ---- ATR (Wilder) over closed bars ----------------------------------------
function atr(candles, len = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const window = trs.slice(-len);
  if (window.length === 0) return 0;
  return window.reduce((s, x) => s + x, 0) / window.length;
}

/**
 * The "one-shot / no-consolidation" test for a pin bar, evaluated over the
 * `lookback` bars ENDING at the bar BEFORE the pin bar (indices
 * [pinIdx-lookback, pinIdx-1]) — exactly the Pine `[1]`-shifted window.
 *
 * Returns { ok, effRatio, netChg, appRange } so the caller can log the
 * efficiency ratio even on rejects.
 *
 *   direction: 'LONG' expects price FALLING into PDH; 'SHORT' expects price
 *              RISING into PDL.
 *   touchedLevelInWindow: did price already tag the level during the approach?
 *   opts: { minEff, minRangeATR, atrLen, lookback, requireDirection,
 *           requireEfficiency, requireNoSqueeze, requireNoPriorTag }
 */
function approachQuality(candles, pinIdx, direction, touchedLevelInWindow, opts = {}) {
  const {
    minEff = 0.55, minRangeATR = 1.2, atrLen = 14, lookback = 4,
    requireDirection = true, requireEfficiency = true,
    requireNoSqueeze = true, requireNoPriorTag = true,
  } = opts;

  const start = pinIdx - lookback;      // inclusive lower bound of the window's close series
  const result = { ok: false, effRatio: 0, netChg: 0, appRange: 0 };
  if (start - 1 < 0) return result;     // need one extra bar before the window for netChg baseline

  // net displacement across the approach: close[pinIdx-1] - close[pinIdx-1-lookback]
  const netChg = candles[pinIdx - 1].close - candles[start - 1].close;
  // total ground covered: sum of |bar-to-bar close change| across the window
  let pathLen = 0;
  for (let i = start; i <= pinIdx - 1; i++) pathLen += Math.abs(candles[i].close - candles[i - 1].close);
  const effRatio = pathLen > 0 ? Math.abs(netChg) / pathLen : 0;

  let appHigh = -Infinity, appLow = Infinity;
  for (let i = start; i <= pinIdx - 1; i++) { appHigh = Math.max(appHigh, candles[i].high); appLow = Math.min(appLow, candles[i].low); }
  const appRange = appHigh - appLow;
  const a = atr(candles.slice(0, pinIdx), atrLen); // ATR of bars before the pin

  result.effRatio = effRatio; result.netChg = netChg; result.appRange = appRange;

  const noPriorTag = !requireNoPriorTag || !touchedLevelInWindow;
  const impulsive = !requireEfficiency || effRatio >= minEff;
  const notCoiled = !requireNoSqueeze || (a > 0 && appRange >= minRangeATR * a);
  const dirOk = !requireDirection || (direction === 'LONG' ? netChg < 0 : netChg > 0);

  result.ok = noPriorTag && impulsive && notCoiled && dirOk;
  return result;
}

// ===========================================================================
//  STRICT v3 detectors — faithful port of the author's v2 alert indicator
//  ("Trading With Sidhant", ~/Downloads/TWS PDHPDL Break & Retest Alerts.txt).
//  Only used when the engine runs config `pdhpdl-v3`; the v1 detectors above
//  are left untouched so historical variants stay reproducible.
// ===========================================================================

/** Candle range must be a real move vs ATR (Pine `bigEnough`). */
function bigEnough(c, atrVal, minBarATR) {
  return range(c) > 0 && range(c) >= minBarATR * (atrVal || 0);
}

/**
 * Strict DIRECTIONAL pin bar (Pine 276-282). A green hammer only counts for a
 * long, a red shooter only for a short; the rejection wick must dominate the
 * whole range, the far wick must be near-absent, and the close must sit in the
 * extreme of the range — plus a min size vs ATR.
 */
function isStrictHammer(c, atrVal, opts = {}) {
  const { wickMult = 2.0, minWickPct = 0.60, maxOppPct = 0.20, closePosMin = 0.60, minBarATR = 0.60, tickSize = 0.05 } = opts;
  const rng = range(c); if (rng <= 0) return false;
  if (!bigEnough(c, atrVal, minBarATR)) return false;
  if (!(c.close > c.open)) return false;                       // directional: green
  const bodyRef = Math.max(body(c), tickSize);
  const closeTopPct = (c.close - c.low) / rng;
  return lowerWick(c) >= wickMult * bodyRef - EPS &&
         lowerWick(c) >= minWickPct * rng - EPS &&
         upperWick(c) <= maxOppPct * rng + EPS &&
         closeTopPct >= closePosMin - EPS;
}
function isStrictShooter(c, atrVal, opts = {}) {
  const { wickMult = 2.0, minWickPct = 0.60, maxOppPct = 0.20, closePosMin = 0.60, minBarATR = 0.60, tickSize = 0.05 } = opts;
  const rng = range(c); if (rng <= 0) return false;
  if (!bigEnough(c, atrVal, minBarATR)) return false;
  if (!(c.close < c.open)) return false;                       // directional: red
  const bodyRef = Math.max(body(c), tickSize);
  const closeBotPct = (c.high - c.close) / rng;
  return upperWick(c) >= wickMult * bodyRef - EPS &&
         upperWick(c) >= minWickPct * rng - EPS &&
         lowerWick(c) <= maxOppPct * rng + EPS &&
         closeBotPct >= closePosMin - EPS;
}

/**
 * Strict PROPER engulfing (Pine 288-298): the engulfed candle must be a real
 * directional bar (not a doji), the engulfing body decisively bigger and mostly
 * body, it swallows the previous candle wicks-and-all, CLOSES beyond its
 * extreme, and is a real move vs ATR.
 */
function isStrictBullEngulf(c, prev, atrVal, opts = {}) {
  const { engulfMult = 1.25, minPrevBody = 0.30, minBodyPct = 0.50, engulfBeyond = true, strictEngulf = true, minBarATR = 0.60, tickSize = 0.05 } = opts;
  const rng = range(c); if (rng <= 0) return false;
  if (!bigEnough(c, atrVal, minBarATR)) return false;
  if (!(c.close > c.open && prev.close < prev.open)) return false;
  const prevBody = Math.abs(prev.close - prev.open);
  const prevRng = Math.max(prev.high - prev.low, tickSize);
  const prevRealBar = prevBody >= minPrevBody * prevRng - EPS;
  const decisive = body(c) >= minBodyPct * rng - EPS;
  const biggerBody = body(c) >= engulfMult * Math.max(prevBody, tickSize) - EPS;
  const wicksOk = !strictEngulf || (c.high >= prev.high - EPS && c.low <= prev.low + EPS);
  return prevRealBar && decisive && biggerBody && wicksOk &&
         c.close >= prev.open - EPS && c.open <= prev.close + EPS &&
         (!engulfBeyond || c.close > prev.high + EPS);
}
function isStrictBearEngulf(c, prev, atrVal, opts = {}) {
  const { engulfMult = 1.25, minPrevBody = 0.30, minBodyPct = 0.50, engulfBeyond = true, strictEngulf = true, minBarATR = 0.60, tickSize = 0.05 } = opts;
  const rng = range(c); if (rng <= 0) return false;
  if (!bigEnough(c, atrVal, minBarATR)) return false;
  if (!(c.close < c.open && prev.close > prev.open)) return false;
  const prevBody = Math.abs(prev.close - prev.open);
  const prevRng = Math.max(prev.high - prev.low, tickSize);
  const prevRealBar = prevBody >= minPrevBody * prevRng - EPS;
  const decisive = body(c) >= minBodyPct * rng - EPS;
  const biggerBody = body(c) >= engulfMult * Math.max(prevBody, tickSize) - EPS;
  const wicksOk = !strictEngulf || (c.high >= prev.high - EPS && c.low <= prev.low + EPS);
  return prevRealBar && decisive && biggerBody && wicksOk &&
         c.close <= prev.open + EPS && c.open >= prev.close - EPS &&
         (!engulfBeyond || c.close < prev.low - EPS);
}

module.exports = {
  body, upperWick, lowerWick, range, atr,
  isHammer, isShooter, isBullishEngulfing, isBearishEngulfing,
  approachQuality,
  isStrictHammer, isStrictShooter, isStrictBullEngulf, isStrictBearEngulf,
};
