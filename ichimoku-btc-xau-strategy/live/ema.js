'use strict';

/**
 * Plain N-period EMA over a chronological bar array's closes. Used for the
 * entry-timeframe (5min) 200 EMA that the MTF strategy's Baseline (Kijun)
 * is compared against.
 *
 * Recomputed from scratch on every call (O(n) in bar count) rather than kept
 * as incremental state -- simpler and fast enough at the bar counts this
 * service holds in memory (a few thousand 5min bars at most before a
 * restart). Seeded with a plain SMA of the first `period` closes, standard
 * EMA convention.
 */
function emaSeries(bars, period) {
  if (bars.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += bars[i].close;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = bars[i].close * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** EMA(period) value at bar index i, or null if not enough history yet. */
function emaAt(bars, i, period) {
  if (i < period - 1) return null;
  // Recompute the series up to i (cheap enough; see module comment).
  const series = emaSeries(bars.slice(0, i + 1), period);
  return series[i] != null ? series[i] : null;
}

module.exports = { emaSeries, emaAt };
