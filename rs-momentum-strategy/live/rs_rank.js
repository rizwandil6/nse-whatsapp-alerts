'use strict';

/**
 * IBD-style relative-strength ranking — a disclosed proxy for TradingView's
 * "Relative Strength for Indian Market" indicator, whose internals aren't
 * public. Not a faithful replication of that specific script; a standard,
 * well-known methodology most such indicators are modeled on (see README).
 *
 * RS_raw(stock, day) = 0.4*relRet(3mo) + 0.2*relRet(6mo) + 0.2*relRet(9mo) + 0.2*relRet(12mo)
 * relRet(N) = stock's N-month return MINUS Nifty's N-month return over the
 * same window (both cumulative from `day` back N months) -- the recent
 * quarter is implicitly weighted higher since it's nested inside all four
 * terms, matching IBD's own recency-weighting rationale.
 *
 * RS_raw is then cross-sectionally percentile-ranked (0-100) across every
 * stock in the universe that has >=12 months of history as of that day --
 * this is what makes it a "ranking" (relative to the whole universe on
 * that specific day), not just a raw number.
 */

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Subtracts `months` calendar months from an ISO date string, returns a new ISO date string. */
function subtractMonths(isoStr, months) {
  const d = new Date(isoStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** Builds a date -> index map for a candle series (assumes ascending, one candle per trading day). */
function buildDateIndexMap(candles) {
  const map = new Map();
  for (let i = 0; i < candles.length; i++) map.set(isoDate(candles[i].timestampMs), i);
  return map;
}

/** Finds the candle index whose date is the closest AT-OR-BEFORE `targetDate` (walks back from `searchFromIdx`). */
function findAtOrBefore(candles, dateIndexMap, targetDate, searchFromIdx) {
  if (dateIndexMap.has(targetDate)) return dateIndexMap.get(targetDate);
  // walk back from searchFromIdx (a nearby index, e.g. the current day's index) to find the nearest prior trading day
  for (let i = Math.min(searchFromIdx, candles.length - 1); i >= 0; i--) {
    if (isoDate(candles[i].timestampMs) <= targetDate) return i;
  }
  return -1;
}

const LOOKBACKS = [
  { months: 3, weight: 0.4 },
  { months: 6, weight: 0.2 },
  { months: 9, weight: 0.2 },
  { months: 12, weight: 0.2 },
];

/**
 * Computes the RS_raw time series for ONE stock against Nifty. Returns an
 * array parallel to `stockCandles`, with `null` for days lacking 12mo of
 * history (both stock and Nifty) yet.
 *
 * `niftyCandles`/`niftyDateMap`: Nifty's own daily series and its date->idx map.
 */
function computeRsRawSeries(stockCandles, niftyCandles, niftyDateMap) {
  const stockDateMap = buildDateIndexMap(stockCandles);
  const series = new Array(stockCandles.length).fill(null);

  for (let i = 0; i < stockCandles.length; i++) {
    const today = isoDate(stockCandles[i].timestampMs);
    const todayClose = stockCandles[i].close;
    const niftyTodayIdx = findAtOrBefore(niftyCandles, niftyDateMap, today, i);
    if (niftyTodayIdx === -1) continue;
    const niftyTodayClose = niftyCandles[niftyTodayIdx].close;

    let rsRaw = 0;
    let allLookbacksAvailable = true;

    for (const { months, weight } of LOOKBACKS) {
      const targetDate = subtractMonths(today, months);
      const stockPastIdx = findAtOrBefore(stockCandles, stockDateMap, targetDate, i);
      const niftyPastIdx = findAtOrBefore(niftyCandles, niftyDateMap, targetDate, niftyTodayIdx);
      if (stockPastIdx === -1 || niftyPastIdx === -1 || stockCandles[stockPastIdx].close <= 0 || niftyCandles[niftyPastIdx].close <= 0) {
        allLookbacksAvailable = false;
        break;
      }
      // reject if the "past" candle found is actually too close to today (insufficient real history, e.g. a recent IPO)
      const daysBack = (stockCandles[i].timestampMs - stockCandles[stockPastIdx].timestampMs) / 86400000;
      if (daysBack < months * 25) {
        // expected ~30 days/month on a calendar basis; 25 gives some slack for weekends/holidays without accepting a too-short window
        allLookbacksAvailable = false;
        break;
      }
      const stockReturn = todayClose / stockCandles[stockPastIdx].close - 1;
      const niftyReturn = niftyTodayClose / niftyCandles[niftyPastIdx].close - 1;
      rsRaw += weight * (stockReturn - niftyReturn);
    }

    series[i] = allLookbacksAvailable ? rsRaw : null;
  }

  return series;
}

/**
 * Cross-sectional percentile ranking. `rsRawBySymbol`: { symbol: { dateStr: rsRaw|null } }.
 * Returns { symbol: { dateStr: percentileRank(0-100)|null } }.
 */
function percentileRankByDate(rsRawBySymbolByDate) {
  const dateSet = new Set();
  for (const bySymbol of Object.values(rsRawBySymbolByDate)) {
    for (const date of Object.keys(bySymbol)) dateSet.add(date);
  }

  const result = {};
  for (const symbol of Object.keys(rsRawBySymbolByDate)) result[symbol] = {};

  for (const date of dateSet) {
    const entries = [];
    for (const [symbol, bySymbol] of Object.entries(rsRawBySymbolByDate)) {
      const v = bySymbol[date];
      if (v != null) entries.push({ symbol, v });
    }
    if (entries.length === 0) continue;
    entries.sort((a, b) => a.v - b.v);
    const n = entries.length;
    for (let i = 0; i < n; i++) {
      const percentile = n === 1 ? 100 : (i / (n - 1)) * 100;
      result[entries[i].symbol][date] = percentile;
    }
  }

  return result;
}

module.exports = { computeRsRawSeries, percentileRankByDate, buildDateIndexMap, isoDate, subtractMonths, LOOKBACKS };
