'use strict';

/**
 * Isolates each of the three named conditions (demand/supply zone, RSI,
 * Bollinger Band / EMA cross) as its OWN standalone entry signal, holding
 * trend + divergence + sector-strength constant as baseline context across
 * all three variants — so the only thing that varies is the condition being
 * tested, not the whole confluence stack.
 *
 * Zone-only: stop/target from the zone itself (same as the combined system).
 * RSI-only / BB-only: no zone exists to derive a stop from, so both use a
 * clearly-labeled FIXED 5% stop / 10% target (2:1 R:R) — a deliberate
 * simplification, not a claim that this is the "right" stop for these.
 */

const fs = require('fs');
const path = require('path');
const { sma, ema, rsi, isSmaRising, isGoldenCross } = require('./indicators');
const { recentlyTouchedUninvalidatedZones } = require('./zones');
const { hasBearishDivergence } = require('./divergence');
const { precompute, asOfIndexForTimestamp } = require('./confluence');
const { simulatePositionalTrade } = require('./simulate_positional');

const CACHE_PATH = path.join(__dirname, 'mtf_candle_cache.json');
const SECTOR_MAP_PATH = path.join(__dirname, 'sector_map.json');
const SECTOR_CACHE_PATH = path.join(__dirname, 'sector_candle_cache.json');

const RSI_MIN = 50;
const RSI_MAX_DAILY = 60;
const RSI_MAX = 75;
const MAX_TREND_SLOPE_PCT = 2;
const FIXED_STOP_PCT = 5;
const FIXED_TARGET_PCT = 10;

function baselineContext(daily, weekly, monthly, sectorMonthly, dailyIdx, weeklyIdx, monthlyIdx) {
  const sma50Now = daily.sma50[dailyIdx];
  const sma50Then = daily.sma50[dailyIdx - 10];
  const slopePct = sma50Then ? ((sma50Now - sma50Then) / sma50Then) * 100 : null;
  const trendRising = isSmaRising(daily.sma50, dailyIdx, 10) && slopePct != null && slopePct <= MAX_TREND_SLOPE_PCT;

  const weeklyDivergence = hasBearishDivergence(weekly.candles, weekly.rsi14, weeklyIdx, { window: 2, lookbackPairs: 1 });
  const monthlyDivergence = hasBearishDivergence(monthly.candles, monthly.rsi14, monthlyIdx, { window: 2, lookbackPairs: 1 });
  const noDivergence = !weeklyDivergence.hasDivergence && !monthlyDivergence.hasDivergence;

  let sectorStrong = true;
  if (sectorMonthly) {
    const idx = asOfIndexForTimestamp(sectorMonthly.candles, daily.candles[dailyIdx].timestampMs);
    if (idx >= 24) {
      const zones = recentlyTouchedUninvalidatedZones(sectorMonthly.candles, idx, 'DEMAND', 10);
      sectorStrong = zones.length > 0;
    }
  }

  return trendRising && noDivergence && sectorStrong;
}

function fixedStopTarget(entryPrice) {
  return { stopLoss: entryPrice * (1 - FIXED_STOP_PCT / 100), target: entryPrice * (1 + FIXED_TARGET_PCT / 100) };
}

function runVariant(cache, sectorMap, sectorPrecomputed, variant) {
  const signals = [];
  for (const [symbol, tf] of Object.entries(cache)) {
    if (!tf.day || tf.day.length < 100) continue;
    const daily = precompute(tf.day);
    const weekly = precompute(tf.week);
    const monthly = precompute(tf.month);
    const sectorName = sectorMap[symbol];
    const sectorMonthly = sectorName ? sectorPrecomputed[sectorName] : null;

    let lastZoneFormationIdx = null; // avoid re-firing every day a zone stays valid

    for (let i = 60; i < tf.day.length - 1; i++) {
      const current = tf.day[i];
      const weeklyIdx = asOfIndexForTimestamp(weekly.candles, current.timestampMs);
      const monthlyIdx = asOfIndexForTimestamp(monthly.candles, current.timestampMs);
      if (weeklyIdx < 60 || monthlyIdx < 24) continue;

      if (!baselineContext(daily, weekly, monthly, sectorMonthly, i, weeklyIdx, monthlyIdx)) continue;

      const entryCandle = tf.day[i + 1];
      const entryGapPct = Math.abs(((entryCandle.open - current.close) / current.close) * 100);
      if (entryGapPct > 1) continue; // keep Proposal 3 constant too

      if (variant === 'ZONE') {
        const zones = recentlyTouchedUninvalidatedZones(tf.day, i, 'DEMAND', 10, [3]);
        if (zones.length === 0) continue;
        const zone = zones[0];
        if (zone.formationIdx === lastZoneFormationIdx) continue; // only first day this zone qualifies
        lastZoneFormationIdx = zone.formationIdx;
        const trade = simulatePositionalTrade(tf.day, i, zone.distal, current.close + 2 * (current.close - zone.distal));
        if (trade) signals.push({ symbol, date: new Date(current.timestampMs).toISOString().slice(0, 10), trade });
      } else if (variant === 'RSI') {
        const rDaily = daily.rsi14[i];
        const rDailyPrev = daily.rsi14[i - 1];
        const rWeekly = weekly.rsi14[weeklyIdx];
        const rMonthly = monthly.rsi14[monthlyIdx];
        const inBand = (v, max) => v != null && v >= RSI_MIN && v <= max;
        const enteredBandToday = rDailyPrev != null && rDailyPrev < RSI_MIN && inBand(rDaily, RSI_MAX_DAILY);
        if (!enteredBandToday || !inBand(rWeekly, RSI_MAX) || !inBand(rMonthly, RSI_MAX)) continue;
        const { stopLoss, target } = fixedStopTarget(current.close);
        const trade = simulatePositionalTrade(tf.day, i, stopLoss, target);
        if (trade) signals.push({ symbol, date: new Date(current.timestampMs).toISOString().slice(0, 10), trade });
      } else if (variant === 'BB') {
        const nowAbove = daily.ema9[i] != null && daily.sma20[i] != null && daily.ema9[i] > daily.sma20[i];
        const prevAbove = daily.ema9[i - 1] != null && daily.sma20[i - 1] != null && daily.ema9[i - 1] > daily.sma20[i - 1];
        if (!nowAbove || prevAbove) continue;
        const { stopLoss, target } = fixedStopTarget(current.close);
        const trade = simulatePositionalTrade(tf.day, i, stopLoss, target);
        if (trade) signals.push({ symbol, date: new Date(current.timestampMs).toISOString().slice(0, 10), trade });
      }
    }
  }
  return signals;
}

function summarize(signals) {
  if (signals.length === 0) return { n: 0 };
  const wins = signals.filter((s) => s.trade.pnlPct > 0).length;
  const avgPnl = signals.reduce((s, x) => s + x.trade.pnlPct, 0) / signals.length;
  const byAction = {};
  signals.forEach((s) => (byAction[s.trade.action] = (byAction[s.trade.action] || 0) + 1));
  return { n: signals.length, winRate: (wins / signals.length) * 100, avgPnl, byAction };
}

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const sectorMap = JSON.parse(fs.readFileSync(SECTOR_MAP_PATH, 'utf8'));
  const sectorCandles = JSON.parse(fs.readFileSync(SECTOR_CACHE_PATH, 'utf8'));
  const sectorPrecomputed = {};
  for (const [name, candles] of Object.entries(sectorCandles)) sectorPrecomputed[name] = precompute(candles);

  console.log('Baseline context held constant across all 3: trend (capped slope) + no-divergence + sector-strength + entry-gap cap.\n');

  for (const variant of ['ZONE', 'RSI', 'BB']) {
    const signals = runVariant(cache, sectorMap, sectorPrecomputed, variant);
    const s = summarize(signals);
    if (s.n === 0) {
      console.log(variant.padEnd(6) + '-> no signals');
      continue;
    }
    console.log(
      `${variant.padEnd(6)} n=${String(s.n).padEnd(4)} win=${s.winRate.toFixed(1).padStart(5)}%  avgPnl=${s.avgPnl.toFixed(2).padStart(7)}%  ${JSON.stringify(s.byAction)}`
    );
  }
}

main();
