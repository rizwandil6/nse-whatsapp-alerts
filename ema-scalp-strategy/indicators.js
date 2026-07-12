'use strict';

/**
 * Pure indicator functions. All take an ascending-by-time array of candles
 * ({open,high,low,close,volume}) and return an array of the SAME LENGTH,
 * with `null` for indices where the indicator isn't yet defined (warmup
 * period) — this keeps every series index-aligned with the input candles,
 * which the zone/signal detectors rely on.
 */

function sma(candles, period, field = 'close') {
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i][field];
    if (i >= period) sum -= candles[i - period][field];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(candles, period, field = 'close') {
  const out = new Array(candles.length).fill(null);
  const k = 2 / (period + 1);
  // seed with SMA of the first `period` values, standard EMA convention
  let seed = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      for (let j = 0; j < period; j++) seed += candles[j][field];
      seed /= period;
      out[i] = seed;
      continue;
    }
    out[i] = candles[i][field] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Wilder's RSI (standard 14-period convention, matches TradingView default). */
function rsi(candles, period = 14, field = 'close') {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i][field] - candles[i - 1][field];
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i][field] - candles[i - 1][field];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Bollinger Bands: middle = SMA(20), upper/lower = middle +/- stdDevMultiplier * rolling stddev. */
function bollingerBands(candles, period = 20, stdDevMultiplier = 2, field = 'close') {
  const middle = sma(candles, period, field);
  const upper = new Array(candles.length).fill(null);
  const lower = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = candles[j][field] - middle[i];
      sumSq += diff * diff;
    }
    const stdDev = Math.sqrt(sumSq / period);
    upper[i] = middle[i] + stdDevMultiplier * stdDev;
    lower[i] = middle[i] - stdDevMultiplier * stdDev;
  }
  return { upper, middle, lower };
}

/**
 * "12 to 3 o'clock" trend filter, operationalized as: is the SMA at index i
 * higher than (or equal to) its value `lookback` bars earlier? True covers
 * everything from a steep rise (12 o'clock) to flat (3 o'clock); false means
 * declining (past 3 o'clock, i.e. sloping the wrong way).
 */
function isSmaRising(smaSeries, i, lookback = 10) {
  if (i < lookback) return false;
  const now = smaSeries[i];
  const then = smaSeries[i - lookback];
  if (now == null || then == null) return false;
  return now >= then;
}

/** Detects an EMA golden cross AT index i: fast was <= slow the bar before, fast > slow now. */
function isGoldenCross(fastSeries, slowSeries, i) {
  if (i < 1) return false;
  const fNow = fastSeries[i];
  const fPrev = fastSeries[i - 1];
  const sNow = slowSeries[i];
  const sPrev = slowSeries[i - 1];
  if (fNow == null || fPrev == null || sNow == null || sPrev == null) return false;
  return fPrev <= sPrev && fNow > sNow;
}

module.exports = { sma, ema, rsi, bollingerBands, isSmaRising, isGoldenCross };
