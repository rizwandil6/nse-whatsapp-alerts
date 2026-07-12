'use strict';

/**
 * 9/15 EMA trend filter. "30 degree slope" is unmeasurable without knowing
 * the source's chart scaling (source itself admits this is subjective) —
 * translated to a %-change-over-lookback proxy, empirically tunable via
 * SLOPE_THRESHOLD_PCT (swept during backtesting, not guessed once and left).
 */

const { ema } = require('./indicators');

const SLOPE_LOOKBACK = 5; // bars
let SLOPE_THRESHOLD_PCT = 0.3; // % change in 9-EMA over the lookback window

function setSlopeThreshold(pct) {
  SLOPE_THRESHOLD_PCT = pct;
}

function computeEmaSeries(candles) {
  return { ema9: ema(candles, 9), ema15: ema(candles, 15) };
}

function slopePct(series, idx, lookback = SLOPE_LOOKBACK) {
  const now = series[idx];
  const then = series[idx - lookback];
  if (now == null || then == null || then === 0) return null;
  return ((now - then) / Math.abs(then)) * 100;
}

/** Returns 'BULLISH' | 'BEARISH' | null (flat/no clear trend). */
function trendDirection(emaSeries, idx) {
  const e9 = emaSeries.ema9[idx];
  const e15 = emaSeries.ema15[idx];
  if (e9 == null || e15 == null) return null;
  const slope = slopePct(emaSeries.ema9, idx);
  if (slope == null || Math.abs(slope) < SLOPE_THRESHOLD_PCT) return null; // flat market, filtered out

  if (e9 > e15 && slope > 0) return 'BULLISH';
  if (e9 < e15 && slope < 0) return 'BEARISH';
  return null; // EMA order and slope disagree — not a clean trend
}

module.exports = { computeEmaSeries, slopePct, trendDirection, setSlopeThreshold, SLOPE_LOOKBACK };
