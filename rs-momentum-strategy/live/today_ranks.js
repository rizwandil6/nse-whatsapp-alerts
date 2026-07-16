'use strict';

/**
 * Computes today's (and yesterday's, needed to detect a fresh crossing)
 * RS percentile rank for every stock in the freshly-fetched universe.
 * Thin wrapper around rs_rank.js's generic time-series functions, used
 * here on the last ~14 months instead of the backtest's full 5-year
 * history — the ranking math is identical either way.
 */

const { computeRsRawSeries, percentileRankByDate, buildDateIndexMap, isoDate } = require('./rs_rank');

/**
 * `universe`: { nifty: [...candles], bySymbol: { symbol: [...candles] } }.
 * Returns { bySymbol: { symbol: { today: {date, rank}, yesterday: {date, rank}|null } } },
 * skipping any symbol without enough history for a valid rank.
 */
function computeTodayRanks(universe) {
  const { nifty, bySymbol } = universe;
  const niftyDateMap = buildDateIndexMap(nifty);

  const rsRawBySymbolByDate = {};
  for (const [symbol, candles] of Object.entries(bySymbol)) {
    if (!candles || candles.length < 60) continue; // not enough data at all -- skip outright
    const series = computeRsRawSeries(candles, nifty, niftyDateMap);
    const byDate = {};
    for (let i = 0; i < candles.length; i++) {
      if (series[i] != null) byDate[isoDate(candles[i].timestampMs)] = series[i];
    }
    if (Object.keys(byDate).length > 0) rsRawBySymbolByDate[symbol] = byDate;
  }

  const ranked = percentileRankByDate(rsRawBySymbolByDate);

  const result = {};
  for (const [symbol, candles] of Object.entries(bySymbol)) {
    const rankByDate = ranked[symbol];
    if (!rankByDate) continue;
    const dates = Object.keys(rankByDate).sort();
    if (dates.length === 0) continue;
    const todayDate = dates[dates.length - 1];
    const yesterdayDate = dates.length >= 2 ? dates[dates.length - 2] : null;
    result[symbol] = {
      today: { date: todayDate, rank: rankByDate[todayDate] },
      yesterday: yesterdayDate ? { date: yesterdayDate, rank: rankByDate[yesterdayDate] } : null,
      currentPrice: candles[candles.length - 1].close,
    };
  }
  return result;
}

module.exports = { computeTodayRanks };
