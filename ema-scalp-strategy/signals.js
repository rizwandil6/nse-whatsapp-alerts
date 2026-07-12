'use strict';

/**
 * Combines EMA trend+slope, candle pattern trigger, and Nifty cross-index
 * confirmation into a day's entry signal. Entry executes at the NEXT
 * candle's open after the trigger candle (backtest-safe — the source's
 * "enter at close of trigger candle" isn't achievable without lookahead).
 */

const { computeEmaSeries, trendDirection } = require('./ema_trend');
const { isBullishTrigger, isBearishTrigger } = require('./candle_patterns');

/**
 * dayCandles: today's 5-min candles for the stock. niftyDayCandles: today's
 * 5-min candles for Nifty (same day, for cross-index confirmation).
 * Returns the FIRST valid signal of the day, or null.
 */
function findDaySignal(dayCandles, niftyDayCandles) {
  if (dayCandles.length < 25 || niftyDayCandles.length < 25) return null;
  const stockEma = computeEmaSeries(dayCandles);
  const niftyEma = computeEmaSeries(niftyDayCandles);

  for (let i = 20; i < dayCandles.length - 1; i++) {
    const stockTrend = trendDirection(stockEma, i);
    if (!stockTrend) continue;

    // align Nifty's bar to the same timestamp (same 5-min grid, so index should match 1:1 if both fetched the same day — but check by timestamp to be safe)
    const niftyIdx = niftyDayCandles.findIndex((c) => c.timestampMs === dayCandles[i].timestampMs);
    if (niftyIdx < 20) continue;
    const niftyTrend = trendDirection(niftyEma, niftyIdx);
    if (niftyTrend !== stockTrend) continue; // require BOTH aligned in the SAME direction ("90% probability" claim)

    const triggerCandle = dayCandles[i];
    const pattern = stockTrend === 'BULLISH' ? isBullishTrigger(dayCandles, i) : isBearishTrigger(dayCandles, i);
    if (!pattern) continue;

    const entryIdx = i + 1;
    if (entryIdx >= dayCandles.length) continue;
    const direction = stockTrend === 'BULLISH' ? 'LONG' : 'SHORT';
    const stopLoss = direction === 'LONG' ? triggerCandle.low : triggerCandle.high;
    const entryPrice = dayCandles[entryIdx].open;
    const risk = direction === 'LONG' ? entryPrice - stopLoss : stopLoss - entryPrice;
    if (risk <= 0) continue; // entry already past its own stop, invalid
    const target = direction === 'LONG' ? entryPrice + 2 * risk : entryPrice - 2 * risk;

    return { direction, pattern, entryIdx, entryPrice, stopLoss, target };
  }
  return null;
}

const IST_OFFSET_MS = 5.5 * 3600000;
function istMinutesSinceMidnight(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * No new entries after this time. Justified structurally, not by sweeping
 * for the best backtest number: 90% of TARGET_HIT trades resolve within 50
 * minutes of entry (see diagnose_time_exit.js), so an entry at 14:30 still
 * has ~50 min of runway before the 15:20 IST square-off. Diagnosis found
 * TIME_EXIT trades cluster hard at 15:00-15:19 entries (61% of them, vs 8%
 * of TARGET_HIT trades) with a median of just 2 bars (10 min) left on the
 * clock at entry — these aren't weak signals, they're signals with no time
 * left to develop. A more aggressive cutoff (14:00) tests even better, but
 * with only 3 distinct trading days of signal activity in the fetch window,
 * that's mostly just discarding one bad day (2026-05-29, 9% target-hit
 * rate) rather than a generalizable timing edge — not adopted for that
 * reason (see README's Known Limitations).
 */
const ENTRY_CUTOFF_MINUTES = 14 * 60 + 30; // 14:30 IST

/**
 * "No opposing wick" tolerance for the Big Bar trigger candle, added per
 * user observation comparing winning vs losing trade charts: winners'
 * trigger candles consistently showed almost no lower wick (no buying
 * pressure showing up mid-candle before close); losers often had a visible
 * lower wick. null = filter disabled (pre-existing behavior). Fraction of
 * the candle's range — see isBigBarNoOpposingWick in candle_patterns.js.
 */
let WICK_TOLERANCE = null;
function setWickTolerance(v) {
  WICK_TOLERANCE = v;
}

/**
 * Narrowed variant: SHORT + BIG_BAR only (the combination that carried
 * almost all the edge in the full 4-way backtest — SHORT 63.5%/+0.311%,
 * BIG_BAR 60.1%/+0.304%, vs LONG+PIN_BAR barely above breakeven).
 * Same entry/stop/target mechanics as findDaySignal, plus the entry-time
 * cutoff above to cut off structurally-doomed late-day entries, plus the
 * optional no-opposing-wick filter (set via setWickTolerance).
 */
function findDaySignalShortBigBarOnly(dayCandles, niftyDayCandles) {
  if (dayCandles.length < 25 || niftyDayCandles.length < 25) return null;
  const stockEma = computeEmaSeries(dayCandles);
  const niftyEma = computeEmaSeries(niftyDayCandles);

  for (let i = 20; i < dayCandles.length - 1; i++) {
    const stockTrend = trendDirection(stockEma, i);
    if (stockTrend !== 'BEARISH') continue;

    const niftyIdx = niftyDayCandles.findIndex((c) => c.timestampMs === dayCandles[i].timestampMs);
    if (niftyIdx < 20) continue;
    const niftyTrend = trendDirection(niftyEma, niftyIdx);
    if (niftyTrend !== 'BEARISH') continue;

    const triggerCandle = dayCandles[i];
    const pattern = isBearishTrigger(dayCandles, i, WICK_TOLERANCE);
    if (pattern !== 'BIG_BAR') continue;

    const entryIdx = i + 1;
    if (entryIdx >= dayCandles.length) continue;
    if (istMinutesSinceMidnight(dayCandles[entryIdx].timestampMs) > ENTRY_CUTOFF_MINUTES) continue;
    const stopLoss = triggerCandle.high;
    const entryPrice = dayCandles[entryIdx].open;
    const risk = stopLoss - entryPrice;
    if (risk <= 0) continue;
    const target = entryPrice - 2 * risk;

    return { direction: 'SHORT', pattern, entryIdx, entryPrice, stopLoss, target };
  }
  return null;
}

module.exports = { findDaySignal, findDaySignalShortBigBarOnly, ENTRY_CUTOFF_MINUTES, setWickTolerance };
