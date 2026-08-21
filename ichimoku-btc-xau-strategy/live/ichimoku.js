'use strict';

/**
 * Pure Ichimoku Kinko Hyo component math, operating on a chronological array
 * of completed bars ({ timestampMs, open, high, low, close, volume }). This
 * module is timeframe-agnostic -- the same functions run against 1H, 30min,
 * and 5min bar arrays (see mtf_engine.js).
 *
 * Periods: Tenkan 9 / Kijun 26 / displacement 26, per the MTF strategy source
 * (wiki/sources/secretmindset-ichimoku-mtf-strategy-video.md, which states
 * "Standard 9/26/26 periods"). Senkou Span B keeps the conventional 52-period
 * lookback -- the "26" in "9/26/26" refers to Kijun and the (always-equal-to-
 * Kijun) forward displacement, not a change to Senkou B's own lookback; this
 * is the same reading `ichimoku-momentum-strategy/live/ichimoku.js` uses.
 *
 * Formulas (wiki/concepts/ichimoku-cloud.md):
 *   Tenkan-sen(i)   = (highest high + lowest low over the last 9 bars ending at i) / 2
 *   Kijun-sen(i)    = (highest high + lowest low over the last 26 bars ending at i) / 2
 *   SenkouSpanA(i)  = (Tenkan(i) + Kijun(i)) / 2                       -- plots forward at i+26
 *   SenkouSpanB(i)  = (highest high + lowest low over the last 52 bars ending at i) / 2  -- plots forward at i+26
 *   Chikou(i)       = close(i)                                        -- plots backward at i-26
 *
 * "cloud hovering over price at bar i" = cloudAt(i) = the Senkou A/B pair that
 * was COMPUTED 26 bars earlier (at i-26) and is only now, at i, actually
 * plotted over price. This is the cloud a trader looking at the chart at bar
 * i would see under the current candle -- used throughout mtf_engine.js for
 * every "price vs cloud" / "cloud color" / invalidation check.
 */

const TENKAN_LEN = 9;
const KIJUN_LEN = 26;
const SENKOU_B_LEN = 52;
const DISPLACEMENT = 26;

function highLowOver(bars, endIdx, len) {
  const start = endIdx - len + 1;
  if (start < 0) return null;
  let hi = -Infinity, lo = Infinity;
  for (let k = start; k <= endIdx; k++) {
    if (bars[k].high > hi) hi = bars[k].high;
    if (bars[k].low < lo) lo = bars[k].low;
  }
  return { hi, lo };
}

function tenkan(bars, i) {
  const r = highLowOver(bars, i, TENKAN_LEN);
  return r ? (r.hi + r.lo) / 2 : null;
}

function kijun(bars, i) {
  const r = highLowOver(bars, i, KIJUN_LEN);
  return r ? (r.hi + r.lo) / 2 : null;
}

/** Senkou Span A computed AT bar i (not yet displaced). Null until Tenkan+Kijun both exist. */
function senkouARaw(bars, i) {
  const t = tenkan(bars, i);
  const k = kijun(bars, i);
  if (t == null || k == null) return null;
  return (t + k) / 2;
}

/** Senkou Span B computed AT bar i (not yet displaced). */
function senkouBRaw(bars, i) {
  const r = highLowOver(bars, i, SENKOU_B_LEN);
  return r ? (r.hi + r.lo) / 2 : null;
}

/** The cloud edges actually hovering over price at bar i (computed 26 bars earlier). */
function cloudAt(bars, i) {
  const j = i - DISPLACEMENT;
  if (j < 0) return null;
  const a = senkouARaw(bars, j);
  const b = senkouBRaw(bars, j);
  if (a == null || b == null) return null;
  return { a, b, top: Math.max(a, b), bottom: Math.min(a, b), green: a > b };
}

/** Chikou (lagging span) value effective at bar i is simply close(i); it plots at i-26. */
function chikou(bars, i) {
  return bars[i] ? bars[i].close : null;
}

module.exports = {
  TENKAN_LEN, KIJUN_LEN, SENKOU_B_LEN, DISPLACEMENT,
  highLowOver, tenkan, kijun, senkouARaw, senkouBRaw, cloudAt, chikou,
};
