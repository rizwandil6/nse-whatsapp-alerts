'use strict';

/**
 * Bearish divergence detection (Classic + Hidden), per the rulebook:
 *   "Classic Bullish Divergence: Price makes a lower low while RSI makes a
 *    higher high/low, signaling a reversal." (given, for the bullish case)
 * By symmetry:
 *   Classic Bearish: price makes a HIGHER high, RSI makes a LOWER high
 *     (momentum weakening even as price rises).
 *   Hidden Bearish: price makes a LOWER high, RSI makes a HIGHER high
 *     (continuation-of-downtrend signal).
 *
 * Swing highs are detected as local maxima using a symmetric fractal window
 * (a candle's high must exceed the `window` candles on each side) — this is
 * lookahead-safe as long as the caller only treats a swing high as "known"
 * once `window` bars past it have elapsed, which detectSwingHighs enforces
 * by simply not being able to see beyond `asOfIndex`.
 */

function detectSwingHighs(candles, asOfIndex, window = 2) {
  const swings = [];
  for (let i = window; i <= asOfIndex - window; i++) {
    let isSwing = true;
    for (let w = 1; w <= window; w++) {
      if (candles[i].high <= candles[i - w].high || candles[i].high <= candles[i + w].high) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) swings.push(i);
  }
  return swings;
}

/**
 * Checks the last `lookbackPairs` consecutive swing-high pairs (as of
 * asOfIndex) for classic or hidden bearish divergence. Returns
 * {hasDivergence, type, details} — type is 'classic' | 'hidden' | null.
 */
function hasBearishDivergence(candles, rsiSeries, asOfIndex, { window = 2, lookbackPairs = 3 } = {}) {
  const swings = detectSwingHighs(candles, asOfIndex, window);
  if (swings.length < 2) return { hasDivergence: false, type: null };

  const recentSwings = swings.slice(-1 * (lookbackPairs + 1)); // need N+1 points for N pairs
  for (let k = recentSwings.length - 1; k > 0; k--) {
    const i2 = recentSwings[k];
    const i1 = recentSwings[k - 1];
    const rsi1 = rsiSeries[i1];
    const rsi2 = rsiSeries[i2];
    if (rsi1 == null || rsi2 == null) continue;

    const priceHigherHigh = candles[i2].high > candles[i1].high;
    const priceLowerHigh = candles[i2].high < candles[i1].high;
    const rsiLowerHigh = rsi2 < rsi1;
    const rsiHigherHigh = rsi2 > rsi1;

    if (priceHigherHigh && rsiLowerHigh) {
      return { hasDivergence: true, type: 'classic', details: { i1, i2, priceHigh1: candles[i1].high, priceHigh2: candles[i2].high, rsi1, rsi2 } };
    }
    if (priceLowerHigh && rsiHigherHigh) {
      return { hasDivergence: true, type: 'hidden', details: { i1, i2, priceHigh1: candles[i1].high, priceHigh2: candles[i2].high, rsi1, rsi2 } };
    }
  }
  return { hasDivergence: false, type: null };
}

module.exports = { detectSwingHighs, hasBearishDivergence };
