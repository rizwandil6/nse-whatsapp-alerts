'use strict';

/**
 * Combined Confluence Strategy (rulebook Section B), wired from the
 * indicators/zones/divergence primitives. Evaluates whether a BUY signal
 * fires at dailyCandles[asOfDailyIndex] (the entry-trigger candle) using
 * only data up to that point on Daily, and the most recent Weekly/Monthly
 * candle that had CLOSED by that daily date (no lookahead across timeframes).
 */

const { sma, ema, rsi, isSmaRising, isGoldenCross } = require('./indicators');
const { activeQualifyingZones, recentlyTouchedUninvalidatedZones, findRawZones, scoreZone, MIN_QUALIFYING_SCORE } = require('./zones');
const { hasBearishDivergence } = require('./divergence');

const RSI_MIN = 50;
const RSI_MAX = 75;
// Proposal 1 (audit finding): Daily RSI 55-60 -> 59.3% win/+4.60% avg; 60-70 ->
// 27.8% win/~0% avg (n=27 vs n=18) — the top of the wider band was hurting, not
// diluting. Tighten Daily ceiling specifically; Weekly/Monthly keep RSI_MAX.
const RSI_MAX_DAILY = 60;
const ZONE_OVERLAP_TOLERANCE_PCT = 3; // "inside or very near" a higher-TF zone
// Proposal 2 (audit finding): slope 0-2% -> 54.3% win/+3.96% avg; slope 2-5% ->
// 40.0% win/+0.59% avg (n=35 vs n=20) — steep recent runs look like a chase,
// not a genuine basing pullback. Cap "12 to 3 o'clock" at a gentle slope.
const MAX_TREND_SLOPE_PCT = 2;
// Proposal 3 (audit finding): entry gap 0.5-1% -> 75.0% win/+5.63% avg; gap 1%+
// -> 25.0% win/-1.66% avg (n=12 vs n=12) — cleanest single finding in the audit.
const MAX_ENTRY_GAP_PCT = 1;

/** Largest index in `series` whose candle has already closed as of `dailyTimestampMs` (no lookahead). */
function asOfIndexForTimestamp(series, dailyTimestampMs) {
  let idx = -1;
  for (let i = 0; i < series.length; i++) {
    if (series[i].timestampMs <= dailyTimestampMs) idx = i;
    else break;
  }
  return idx;
}

function zonesOverlapOrNear(zoneA, zoneB, tolerancePct) {
  const aLo = Math.min(zoneA.proximal, zoneA.distal);
  const aHi = Math.max(zoneA.proximal, zoneA.distal);
  const bLo = Math.min(zoneB.proximal, zoneB.distal);
  const bHi = Math.max(zoneB.proximal, zoneB.distal);
  const tolerance = (bHi - bLo) * (tolerancePct / 100) || bHi * (tolerancePct / 100);
  const expandedBLo = bLo - tolerance;
  const expandedBHi = bHi + tolerance;
  return aLo <= expandedBHi && aHi >= expandedBLo;
}

/**
 * Precomputes all indicator series for a timeframe once (perf: avoid
 * recomputing full-history indicators on every bar during a backtest scan).
 */
function precompute(candles) {
  return {
    candles,
    sma50: sma(candles, 50),
    ema20: ema(candles, 20),
    ema50: ema(candles, 50),
    ema9: ema(candles, 9),
    sma20: sma(candles, 20),
    rsi14: rsi(candles, 14),
  };
}

/**
 * Nearest qualifying SUPPLY zone strictly above `entryPrice` on a single
 * timeframe, using its proximal (near/lower) edge as the target — price
 * approaching from below is expected to react at the first touch of a
 * supply zone, not its far edge.
 */
function nearestSupplyZoneOnTimeframe(candles, asOfIndex, entryPrice) {
  const raw = findRawZones(candles, asOfIndex).filter((z) => z.type === 'SUPPLY' && z.formationIdx < asOfIndex);
  let best = null;
  for (const zone of raw) {
    if (zone.proximal <= entryPrice) continue; // must be above entry to be a valid target
    const score = scoreZone(zone, candles, asOfIndex);
    if (score.total < MIN_QUALIFYING_SCORE) continue;
    if (!best || zone.proximal < best.proximal) best = zone;
  }
  return best;
}

/**
 * Nearest qualifying SUPPLY zone above entry, searching BOTH Daily and
 * Weekly (same price scale, same stock — no conversion needed). Empirical
 * finding: only searching Daily surfaced a real target on just 15/88 (17%)
 * of trades, forcing the rest onto the materially weaker FIXED_RR fallback
 * (43.8% win vs 73.3% for SUPPLY_ZONE-targeted trades). Weekly zones are
 * larger/more significant resistance levels a Daily-only scan would miss.
 */
function nearestSupplyZoneTarget(dCandles, dailyIdx, weekly, weeklyIdx, entryPrice) {
  const dailyBest = nearestSupplyZoneOnTimeframe(dCandles, dailyIdx, entryPrice);
  const weeklyBest = weekly ? nearestSupplyZoneOnTimeframe(weekly.candles, weeklyIdx, entryPrice) : null;
  if (dailyBest && weeklyBest) return dailyBest.proximal <= weeklyBest.proximal ? dailyBest : weeklyBest;
  return dailyBest || weeklyBest;
}

/**
 * Sector-strength check (rulebook Section C): the stock's sector index must
 * itself be in a qualifying demand zone (Monthly). `sectorMonthly` is a
 * precompute() result for the relevant sector index, or null if the stock
 * has no confident sector classification (see sector_map.json coverage
 * notes) — in that case the check is skipped/passed-through, not silently
 * failed, and the caller should track that distinction.
 */
function sectorIsStrong(sectorMonthly, dailyTimestampMs) {
  if (!sectorMonthly) return { applicable: false, strong: null };
  const idx = asOfIndexForTimestamp(sectorMonthly.candles, dailyTimestampMs);
  if (idx < 24) return { applicable: false, strong: null };
  const zones = activeQualifyingZones(sectorMonthly.candles, idx, 'DEMAND');
  return { applicable: true, strong: zones.length > 0 };
}

/**
 * Checks the full confluence signal at dailyIdx. `daily`, `weekly`,
 * `monthly` are precompute() results. Returns {fires, checks, zone,
 * stopLoss, target} — checks holds every sub-condition's pass/fail for
 * transparency/debugging.
 */
function checkSignal(daily, weekly, monthly, dailyIdx, sectorMonthly = null) {
  const dCandles = daily.candles;
  const current = dCandles[dailyIdx];

  const weeklyIdx = asOfIndexForTimestamp(weekly.candles, current.timestampMs);
  const monthlyIdx = asOfIndexForTimestamp(monthly.candles, current.timestampMs);
  if (weeklyIdx < 60 || monthlyIdx < 24) {
    // not enough higher-TF history yet for meaningful indicators/zones
    return { fires: false, checks: { insufficientHistory: true } };
  }

  const checks = {};

  // 1. Trend filter: 50 SMA rising on Daily ("Intermediate Timeframe"), capped
  // at a gentle slope (Proposal 2) — steep run-ups underperform.
  const sma50Now = daily.sma50[dailyIdx];
  const sma50Then = daily.sma50[dailyIdx - 10];
  const trendSlopePct = sma50Then ? ((sma50Now - sma50Then) / sma50Then) * 100 : null;
  checks.trendRising = isSmaRising(daily.sma50, dailyIdx, 10) && trendSlopePct != null && trendSlopePct <= MAX_TREND_SLOPE_PCT;

  // 2. Zone location: DAILY demand zone touched recently (within lookback) and not
  // since invalidated — NOT required to still contain today's close (see
  // recentlyTouchedUninvalidatedZones doc comment for why: the bounce that
  // confirms the trade is the same bounce that lifts price off the zone).
  // Confluent with a WEEKLY or MONTHLY zone touched/valid on the same basis.
  // Empirical finding: 3-base-candle zones underperform badly (n=7, 28.6% win,
  // +0.20% avg) vs 2-base (n=20, 55.0% win, +4.30% avg) and 1-base (n=28, 46.4%
  // win, +2.77% avg) — contradicts the rulebook's "1-3 candles = powerful"
  // framing. Excluding 3-candle bases from the DAILY demand zone specifically
  // (not touching the supply-zone target search, which wasn't analyzed here).
  const dailyZones = recentlyTouchedUninvalidatedZones(dCandles, dailyIdx, 'DEMAND', 10, [3]);
  checks.hasDailyZone = dailyZones.length > 0;
  let confluentZone = null;
  if (checks.hasDailyZone) {
    const weeklyZones = recentlyTouchedUninvalidatedZones(weekly.candles, weeklyIdx, 'DEMAND', 10);
    const monthlyZones = recentlyTouchedUninvalidatedZones(monthly.candles, monthlyIdx, 'DEMAND', 10);
    for (const dz of dailyZones) {
      const overlapsWeekly = weeklyZones.some((wz) => zonesOverlapOrNear(dz, wz, ZONE_OVERLAP_TOLERANCE_PCT));
      const overlapsMonthly = monthlyZones.some((mz) => zonesOverlapOrNear(dz, mz, ZONE_OVERLAP_TOLERANCE_PCT));
      if (overlapsWeekly || overlapsMonthly) {
        confluentZone = dz;
        break;
      }
    }
  }
  checks.hasConfluentZone = !!confluentZone;

  // 3. Momentum: RSI in band on all three timeframes; no bearish divergence on
  // Monthly/Weekly. Daily ceiling tightened to 60 (Proposal 1) — Weekly/Monthly
  // keep the wider 50-75 band (not separately analyzed in the audit).
  const rsiDaily = daily.rsi14[dailyIdx];
  const rsiWeekly = weekly.rsi14[weeklyIdx];
  const rsiMonthly = monthly.rsi14[monthlyIdx];
  const inBand = (v, max = RSI_MAX) => v != null && v >= RSI_MIN && v <= max;
  checks.rsiOk = inBand(rsiDaily, RSI_MAX_DAILY) && inBand(rsiWeekly) && inBand(rsiMonthly);
  checks.rsiValues = { daily: rsiDaily, weekly: rsiWeekly, monthly: rsiMonthly };

  // lookbackPairs=1: only the MOST RECENT swing-high pair — older divergences
  // go stale as new price action develops; checking 2-3 pairs back (prior
  // setting) was flagging momentum weakness that's no longer current.
  const weeklyDivergence = hasBearishDivergence(weekly.candles, weekly.rsi14, weeklyIdx, { window: 2, lookbackPairs: 1 });
  const monthlyDivergence = hasBearishDivergence(monthly.candles, monthly.rsi14, monthlyIdx, { window: 2, lookbackPairs: 1 });
  checks.noDivergence = !weeklyDivergence.hasDivergence && !monthlyDivergence.hasDivergence;

  // 4. Entry trigger: 9 EMA crosses above 20 SMA (middle BB) AT this candle
  const nowAbove = daily.ema9[dailyIdx] != null && daily.sma20[dailyIdx] != null && daily.ema9[dailyIdx] > daily.sma20[dailyIdx];
  const prevAbove =
    dailyIdx > 0 && daily.ema9[dailyIdx - 1] != null && daily.sma20[dailyIdx - 1] != null && daily.ema9[dailyIdx - 1] > daily.sma20[dailyIdx - 1];
  checks.bbTrigger = nowAbove && !prevAbove;

  // Golden cross bonus (informational, not gating)
  checks.recentGoldenCross = [0, 1, 2, 3, 4].some((back) => dailyIdx - back >= 0 && isGoldenCross(daily.ema20, daily.ema50, dailyIdx - back));

  // 5. Sector strength (rulebook Section C): sector index itself in a Monthly demand zone.
  // Only gates the signal when a confident sector classification exists (see sector_map.json);
  // otherwise pass-through, tracked via checks.sectorApplicable for transparency.
  const sector = sectorIsStrong(sectorMonthly, current.timestampMs);
  checks.sectorApplicable = sector.applicable;
  checks.sectorStrong = sector.applicable ? sector.strong : true; // pass-through when not applicable

  // 6. Entry-gap cap (Proposal 3): skip if next-day open gaps too far from the
  // signal-day close — realistic (a trader sees the opening gap before deciding
  // whether to actually execute), not lookahead on the signal decision itself.
  const entryCandle = dCandles[dailyIdx + 1];
  const entryGapPct = entryCandle ? Math.abs(((entryCandle.open - current.close) / current.close) * 100) : null;
  checks.entryGapOk = entryGapPct != null && entryGapPct <= MAX_ENTRY_GAP_PCT;

  const fires =
    checks.trendRising &&
    checks.hasConfluentZone &&
    checks.rsiOk &&
    checks.noDivergence &&
    checks.bbTrigger &&
    checks.sectorStrong &&
    checks.entryGapOk;

  let stopLoss = null;
  let target = null;
  let targetSource = null;
  let supplyZone = null;
  if (fires && confluentZone) {
    stopLoss = confluentZone.distal;
    const risk = current.close - stopLoss;
    supplyZone = nearestSupplyZoneTarget(dCandles, dailyIdx, weekly, weeklyIdx, current.close);
    // Empirical finding from the first 88-trade backtest: SUPPLY_ZONE targets hit
    // 73.3% of the time (avg +5.62%) vs 43.8% (avg +2.17%) for the FIXED_RR
    // fallback — a real resistance level is a much better target than an
    // arbitrary multiple. Two follow-up experiments did NOT hold up and were
    // reverted: loosening the acceptance threshold below 1:1 R:R (routed a
    // couple more trades to SUPPLY_ZONE but didn't move the numbers), and
    // shrinking the FIXED_RR fallback to 1:1.5 (raised win rate 48.9% -> 51.1%
    // but avg P&L dropped 2.76% -> 1.95% — traded away more reward than the
    // extra wins were worth). What DID help: searching Weekly zones too, not
    // just Daily — more trades find a real target (14 vs original 15, similar
    // count but better selection) and blended avg P&L rose slightly to 2.85%
    // at the same win rate. Kept at the original 1:1 acceptance / 1:2 fallback.
    if (supplyZone && supplyZone.proximal >= current.close + risk) {
      target = supplyZone.proximal;
      targetSource = 'SUPPLY_ZONE';
    } else {
      target = current.close + 2 * risk;
      targetSource = 'FIXED_RR';
    }
  }

  return { fires, checks, zone: confluentZone, entryPrice: current.close, stopLoss, target, targetSource, supplyZone };
}

module.exports = { precompute, checkSignal, asOfIndexForTimestamp, zonesOverlapOrNear };
