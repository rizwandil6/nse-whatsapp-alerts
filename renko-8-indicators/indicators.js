'use strict';

/**
 * Indicator library computed on Renko brick series (brick.open/high/low/close),
 * fresh implementation for this build. All indicators use brick.high =
 * max(open,close) and brick.low = min(open,close) as OHLC substitutes,
 * since traditional Renko bricks are rectangular and don't otherwise carry
 * independent high/low -- standard treatment when running bar-based
 * indicators on a brick series.
 *
 * "Offset" (Bollinger/Donchian/10-SMA) matches TradingView's Offset input:
 * a positive offset of N means the value SHOWN/compared at brick i is the
 * value that was actually computed as of brick i-N -- i.e. offsetSeries[i]
 * = series[i - N]. This is what "brick closes above the offset band"
 * means: comparing current price against an intentionally-lagged band.
 */

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function stdev(values, period, smaSeries) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const mean = smaSeries[i];
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

function rollingMax(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.max(m, values[j]);
    out[i] = m;
  }
  return out;
}

function rollingMin(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.min(m, values[j]);
    out[i] = m;
  }
  return out;
}

/** offsetSeries[i] = series[i - offset], null before that's available. */
function applyOffset(series, offset) {
  if (offset === 0) return series;
  const out = new Array(series.length).fill(null);
  for (let i = offset; i < series.length; i++) out[i] = series[i - offset];
  return out;
}

/** Stochastic Oscillator: %K (raw, then slowed) and %D. */
function stochastic(bricks, kPeriod, dPeriod, slowing) {
  const n = bricks.length;
  const highs = bricks.map((b) => b.high);
  const lows = bricks.map((b) => b.low);
  const closes = bricks.map((b) => b.close);
  const hh = rollingMax(highs, kPeriod);
  const ll = rollingMin(lows, kPeriod);
  const rawK = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (hh[i] == null || ll[i] == null) continue;
    const range = hh[i] - ll[i];
    rawK[i] = range > 0 ? ((closes[i] - ll[i]) / range) * 100 : 50;
  }
  const kFiltered = rawK.map((v) => (v == null ? 0 : v));
  const kSlowed = sma(kFiltered, slowing).map((v, i) => (rawK[i] == null ? null : v));
  const dFiltered = kSlowed.map((v) => (v == null ? 0 : v));
  const d = sma(dFiltered, dPeriod).map((v, i) => (kSlowed[i] == null ? null : v));
  return { k: kSlowed, d };
}

/** Bollinger Bands with offset support. */
function bollinger(bricks, period, stdDevMult, offset) {
  const closes = bricks.map((b) => b.close);
  const mid = sma(closes, period);
  const dev = stdev(closes, period, mid);
  const upper = mid.map((m, i) => (m == null ? null : m + stdDevMult * dev[i]));
  const lower = mid.map((m, i) => (m == null ? null : m - stdDevMult * dev[i]));
  return { middle: applyOffset(mid, offset), upper: applyOffset(upper, offset), lower: applyOffset(lower, offset) };
}

/** Donchian Bands with offset support. */
function donchian(bricks, period, offset) {
  const highs = bricks.map((b) => b.high);
  const lows = bricks.map((b) => b.low);
  const upper = rollingMax(highs, period);
  const lower = rollingMin(lows, period);
  const middle = upper.map((u, i) => (u == null ? null : (u + lower[i]) / 2));
  return { upper: applyOffset(upper, offset), lower: applyOffset(lower, offset), middle: applyOffset(middle, offset) };
}

/** Directional Movement Index: +DI / -DI (Wilder smoothing), no ADX (per source: "ADX removed/hidden"). */
function dmi(bricks, period) {
  const n = bricks.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = bricks[i].high - bricks[i - 1].high;
    const downMove = bricks[i - 1].low - bricks[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      bricks[i].high - bricks[i].low,
      Math.abs(bricks[i].high - bricks[i - 1].close),
      Math.abs(bricks[i].low - bricks[i - 1].close)
    );
  }
  const wilderSmooth = (arr) => {
    const out = new Array(n).fill(null);
    let sum = 0;
    for (let i = 1; i <= period && i < n; i++) sum += arr[i];
    if (period < n) out[period] = sum;
    for (let i = period + 1; i < n; i++) out[i] = out[i - 1] - out[i - 1] / period + arr[i];
    return out;
  };
  const smTR = wilderSmooth(tr);
  const smPlusDM = wilderSmooth(plusDM);
  const smMinusDM = wilderSmooth(minusDM);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (smTR[i] == null || smTR[i] === 0) continue;
    plusDI[i] = (smPlusDM[i] / smTR[i]) * 100;
    minusDI[i] = (smMinusDM[i] / smTR[i]) * 100;
  }
  return { plusDI, minusDI };
}

/**
 * Awesome Oscillator, "line style": AO = SMA5(median) - SMA34(median),
 * median = (high+low)/2. Color/direction: 'green' if AO rising vs prior
 * bar, 'red' if falling -- source explicitly asks for line-color reading,
 * not the histogram's own coloring convention.
 */
function awesomeOscillator(bricks) {
  const median = bricks.map((b) => (b.high + b.low) / 2);
  const fast = sma(median, 5);
  const slow = sma(median, 34);
  const ao = fast.map((f, i) => (f == null || slow[i] == null ? null : f - slow[i]));
  const color = new Array(bricks.length).fill(null);
  for (let i = 1; i < ao.length; i++) {
    if (ao[i] == null || ao[i - 1] == null) continue;
    color[i] = ao[i] > ao[i - 1] ? 'green' : ao[i] < ao[i - 1] ? 'red' : color[i - 1];
  }
  return { value: ao, color };
}

module.exports = { sma, stdev, rollingMax, rollingMin, applyOffset, stochastic, bollinger, donchian, dmi, awesomeOscillator };
