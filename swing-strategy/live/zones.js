'use strict';

/**
 * Demand/Supply zone detection per the rulebook:
 *   - Base candle: body < 50% of range (high-low). "Boring" candle.
 *   - Leg-out candle: body > 50% of range. "Exciting" candle. Its direction
 *     determines zone type: leg-out UP (close>open) -> DEMAND zone left
 *     behind; leg-out DOWN -> SUPPLY zone left behind.
 *   - Zone box = the base candles' range: proximal = highest body edge,
 *     distal = lowest wick (demand) / proximal = lowest body edge, distal =
 *     highest wick (supply).
 *   - 1-3 base candles = "powerful", 7+ = "garbage" (excluded entirely, not
 *     just low-scored, per the rulebook's own wording).
 *
 * All lookahead-safe: findRawZones() only uses candles up to `asOfIndex`;
 * scoring (freshness = retest count) only counts retests between zone
 * formation and asOfIndex, never beyond it.
 */

const MAX_BASE_CANDLES = 6; // >6 excluded as "garbage area" per rulebook
const MIN_QUALIFYING_SCORE = 5; // out of 7 (see proposed defaults discussed with user)

function bodyFrac(c) {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return Math.abs(c.close - c.open) / range;
}
function isBaseCandle(c) {
  return bodyFrac(c) < 0.5;
}
function isExcitingCandle(c) {
  return bodyFrac(c) > 0.5;
}
function isBullish(c) {
  return c.close > c.open;
}

/**
 * Scans candles[0..asOfIndex] for leg-in/base/leg-out patterns. Returns raw
 * zone candidates (unscored) — each with formation index (index of the
 * leg-out candle) and box boundaries.
 */
function findRawZones(candles, asOfIndex) {
  const zones = [];
  for (let legOutIdx = 2; legOutIdx <= asOfIndex; legOutIdx++) {
    const legOut = candles[legOutIdx];
    if (!isExcitingCandle(legOut)) continue;

    // walk backwards from legOutIdx-1 collecting consecutive base candles
    let baseStart = legOutIdx - 1;
    while (baseStart > 0 && isBaseCandle(candles[baseStart]) && legOutIdx - baseStart <= MAX_BASE_CANDLES + 1) {
      baseStart--;
    }
    baseStart++; // baseStart now points to the first base candle
    const baseEnd = legOutIdx - 1; // last base candle index
    const baseCount = baseEnd - baseStart + 1;
    if (baseCount < 1 || baseCount > MAX_BASE_CANDLES) continue;
    const legInIdx = baseStart - 1;
    if (legInIdx < 0) continue;
    const legIn = candles[legInIdx];

    const baseCandles = candles.slice(baseStart, baseEnd + 1);
    const type = isBullish(legOut) ? 'DEMAND' : 'SUPPLY';

    let proximal, distal;
    if (type === 'DEMAND') {
      proximal = Math.max(...baseCandles.map((c) => Math.max(c.open, c.close)));
      distal = Math.min(...baseCandles.map((c) => c.low));
    } else {
      proximal = Math.min(...baseCandles.map((c) => Math.min(c.open, c.close)));
      distal = Math.max(...baseCandles.map((c) => c.high));
    }

    zones.push({
      type,
      formationIdx: legOutIdx,
      legInIdx,
      baseStart,
      baseEnd,
      baseCount,
      proximal,
      distal,
      legOut,
      legIn,
    });
  }
  return zones;
}

/** Counts how many times price has entered [distal,proximal] between formation and asOfIndex (exclusive of formation candle itself). */
function countRetests(zone, candles, asOfIndex) {
  const lo = Math.min(zone.proximal, zone.distal);
  const hi = Math.max(zone.proximal, zone.distal);
  let retests = 0;
  let wasInside = false;
  for (let i = zone.formationIdx + 1; i <= asOfIndex; i++) {
    const c = candles[i];
    const overlaps = c.low <= hi && c.high >= lo;
    if (overlaps && !wasInside) retests++;
    wasInside = overlaps;
  }
  return retests;
}

function scoreZone(zone, candles, asOfIndex) {
  // Freshness (3 pts): never retested = 3, once = 2, twice = 1, 3+ = 0
  const retests = countRetests(zone, candles, asOfIndex);
  const freshness = retests === 0 ? 3 : retests === 1 ? 2 : retests === 2 ? 1 : 0;

  // Strength/leg-out (2 pts): gap or 2+ consecutive exciting candles in leg-out direction = 2, single strong = 1, else 0
  const legOutDir = zone.type === 'DEMAND' ? 1 : -1;
  let strength = 1; // baseline: we already required legOut to be exciting to form the zone at all
  const gapExists =
    zone.type === 'DEMAND' ? zone.legOut.low > zone.legIn.high : zone.legOut.high < zone.legIn.low;
  const nextIdx = zone.formationIdx + 1;
  const nextIsExcitingSameDir =
    nextIdx < candles.length &&
    isExcitingCandle(candles[nextIdx]) &&
    (legOutDir === 1 ? isBullish(candles[nextIdx]) : !isBullish(candles[nextIdx]));
  if (gapExists || nextIsExcitingSameDir) strength = 2;

  // Time at base (2 pts): 1-3 candles = 2, 4-6 = 1 (7+ already excluded at detection)
  const timeAtBase = zone.baseCount <= 3 ? 2 : 1;

  const total = freshness + strength + timeAtBase;
  return { freshness, strength, timeAtBase, total, retests };
}

/**
 * Returns qualifying (score >= MIN_QUALIFYING_SCORE) zones whose box
 * [distal,proximal] contains the CURRENT candle's close at asOfIndex —
 * i.e. "price is at a demand/supply zone right now."
 */
function activeQualifyingZones(candles, asOfIndex, type) {
  const raw = findRawZones(candles, asOfIndex).filter((z) => z.type === type && z.formationIdx < asOfIndex);
  const current = candles[asOfIndex];
  const active = [];
  for (const zone of raw) {
    const lo = Math.min(zone.proximal, zone.distal);
    const hi = Math.max(zone.proximal, zone.distal);
    const priceInside = current.close >= lo && current.close <= hi;
    if (!priceInside) continue;
    const score = scoreZone(zone, candles, asOfIndex);
    if (score.total >= MIN_QUALIFYING_SCORE) active.push({ ...zone, score });
  }
  // prefer the most recently formed qualifying zone
  active.sort((a, b) => b.formationIdx - a.formationIdx);
  return active;
}

/**
 * Zones that were TOUCHED within the last `lookbackDays` (price's low dipped
 * into [distal,proximal] for demand) and have NOT been invalidated since
 * that touch (price hasn't closed below the distal/stop line). Unlike
 * activeQualifyingZones (which requires TODAY'S close to sit inside the
 * box), this allows the entry trigger to fire a few days AFTER the actual
 * touch — the realistic sequence for a zone bounce: touch -> base/recover ->
 * RSI + EMA cross confirm -> enter, by which point price has typically
 * already lifted off the zone.
 */
function recentlyTouchedUninvalidatedZones(candles, asOfIndex, type, lookbackDays = 10, excludeBaseCounts = []) {
  const raw = findRawZones(candles, asOfIndex).filter(
    (z) => z.type === type && z.formationIdx < asOfIndex && !excludeBaseCounts.includes(z.baseCount)
  );
  const results = [];
  for (const zone of raw) {
    const lo = Math.min(zone.proximal, zone.distal);
    const hi = Math.max(zone.proximal, zone.distal);
    let lastTouchIdx = -1;
    for (let i = zone.formationIdx + 1; i <= asOfIndex; i++) {
      const c = candles[i];
      const touched = type === 'DEMAND' ? c.low <= hi : c.high >= lo;
      if (touched) lastTouchIdx = i;
    }
    if (lastTouchIdx === -1 || asOfIndex - lastTouchIdx > lookbackDays) continue;

    // invalidated if price closed beyond the distal (stop) line since the touch
    let invalidated = false;
    for (let i = lastTouchIdx; i <= asOfIndex; i++) {
      const c = candles[i];
      if (type === 'DEMAND' ? c.close < zone.distal : c.close > zone.distal) {
        invalidated = true;
        break;
      }
    }
    if (invalidated) continue;

    const score = scoreZone(zone, candles, asOfIndex);
    if (score.total >= MIN_QUALIFYING_SCORE) results.push({ ...zone, score, lastTouchIdx });
  }
  results.sort((a, b) => b.formationIdx - a.formationIdx);
  return results;
}

module.exports = {
  findRawZones,
  scoreZone,
  countRetests,
  activeQualifyingZones,
  recentlyTouchedUninvalidatedZones,
  isBaseCandle,
  isExcitingCandle,
  bodyFrac,
  MIN_QUALIFYING_SCORE,
};
