'use strict';

/**
 * Candle pattern detectors for the 9/15 EMA scalping strategy. Precise
 * definitions are proposed interpretations (source gives no mathematical
 * criteria beyond visual description — see chat).
 */

function bodyFrac(c) {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return Math.abs(c.close - c.open) / range;
}
function lowerWickFrac(c) {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return (Math.min(c.open, c.close) - c.low) / range;
}
function upperWickFrac(c) {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return (c.high - Math.max(c.open, c.close)) / range;
}

const PIN_BAR_MAX_BODY = 0.3;
const PIN_BAR_MIN_WICK = 0.6;

/** Bullish pin bar: small body, long lower wick (rejection of downside). */
function isBullishPinBar(c) {
  return bodyFrac(c) < PIN_BAR_MAX_BODY && lowerWickFrac(c) >= PIN_BAR_MIN_WICK;
}
/** Bearish pin bar: small body, long upper wick (rejection of upside). */
function isBearishPinBar(c) {
  return bodyFrac(c) < PIN_BAR_MAX_BODY && upperWickFrac(c) >= PIN_BAR_MIN_WICK;
}

const ENGULFING_MIN_BODY = 0.6;

/** "Flower body" / bullish engulfing: strong-bodied candle whose body engulfs the prior candle's body. */
function isBullishEngulfing(candle, prevCandle) {
  if (bodyFrac(candle) < ENGULFING_MIN_BODY || candle.close <= candle.open) return false;
  return candle.open <= Math.min(prevCandle.open, prevCandle.close) && candle.close >= Math.max(prevCandle.open, prevCandle.close);
}
function isBearishEngulfing(candle, prevCandle) {
  if (bodyFrac(candle) < ENGULFING_MIN_BODY || candle.close >= candle.open) return false;
  return candle.open >= Math.max(prevCandle.open, prevCandle.close) && candle.close <= Math.min(prevCandle.open, prevCandle.close);
}

const BIG_BAR_RANGE_MULTIPLE = 1.5;

/** Big bar: range >= 1.5x the average range of the preceding N candles. */
function isBigBar(candles, idx, lookback = 10) {
  if (idx < lookback) return false;
  const window = candles.slice(idx - lookback, idx);
  const avgRange = window.reduce((s, c) => s + (c.high - c.low), 0) / window.length;
  if (avgRange <= 0) return false;
  const range = candles[idx].high - candles[idx].low;
  return range >= avgRange * BIG_BAR_RANGE_MULTIPLE;
}

/**
 * "No opposing wick" Big Bar filter, added per user observation across many
 * winning vs losing trades: winners' trigger candles showed almost no wick
 * on the side that would represent pressure against the trade direction —
 * for a SHORT (bearish) trigger, a lower wick means price dipped and got
 * bought back up before the candle closed (buying pressure mid-candle,
 * exactly what the user flagged in losing trades); for a LONG (bullish)
 * trigger, an upper wick means a rejected push higher (selling pressure).
 * Tolerance is a fraction of the candle's range, not exactly 0 (real data
 * essentially never prints a literal zero-wick candle).
 */
function isBigBarNoOpposingWick(candles, idx, direction, wickTolerance, lookback = 10) {
  if (!isBigBar(candles, idx, lookback)) return false;
  const c = candles[idx];
  if (direction === 'BEARISH') return c.close < c.open && lowerWickFrac(c) <= wickTolerance;
  return c.close > c.open && upperWickFrac(c) <= wickTolerance;
}

/** Any of the three trigger patterns, bullish direction. wickTolerance: optional, applies only to BIG_BAR. */
function isBullishTrigger(candles, idx, wickTolerance = null) {
  const c = candles[idx];
  if (isBullishPinBar(c)) return 'PIN_BAR';
  if (idx > 0 && isBullishEngulfing(c, candles[idx - 1])) return 'FLOWER_BODY';
  if (wickTolerance != null) {
    if (isBigBarNoOpposingWick(candles, idx, 'BULLISH', wickTolerance)) return 'BIG_BAR';
    return null;
  }
  if (isBigBar(candles, idx) && c.close > c.open) return 'BIG_BAR';
  return null;
}
function isBearishTrigger(candles, idx, wickTolerance = null) {
  const c = candles[idx];
  if (isBearishPinBar(c)) return 'PIN_BAR';
  if (idx > 0 && isBearishEngulfing(c, candles[idx - 1])) return 'FLOWER_BODY';
  if (wickTolerance != null) {
    if (isBigBarNoOpposingWick(candles, idx, 'BEARISH', wickTolerance)) return 'BIG_BAR';
    return null;
  }
  if (isBigBar(candles, idx) && c.close < c.open) return 'BIG_BAR';
  return null;
}

module.exports = {
  bodyFrac,
  lowerWickFrac,
  upperWickFrac,
  isBullishPinBar,
  isBearishPinBar,
  isBullishEngulfing,
  isBearishEngulfing,
  isBigBar,
  isBigBarNoOpposingWick,
  isBullishTrigger,
  isBearishTrigger,
};
