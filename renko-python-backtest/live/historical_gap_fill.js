'use strict';

/**
 * Fills the gap between a symbol's seed_data/{symbol}.csv (last date) and
 * "now", via Upstox's V3 date-ranged historical-candle endpoint --
 * confirmed format: /v3/historical-candle/{instrument_key}/{unit}/{interval}/{to_date}/{from_date}
 * (minutes data available back to Jan 2022, so a realistic gap -- even
 * weeks/months -- is well within range; this is a DIFFERENT endpoint than
 * the intraday-only one the sibling DarvasBox streamer uses for "today so
 * far", which only returns the CURRENT day's candles).
 *
 * NSE holidays in the gap legitimately return empty candle sets for some
 * days -- treated as normal here, not an error worth aborting startup on.
 */

const FETCH_TIMEOUT_MS = 10 * 1000;
const HISTORICAL_RANGE_BASE = 'https://api.upstox.com/v3/historical-candle';
const HISTORICAL_INTRADAY_BASE = 'https://api.upstox.com/v3/historical-candle/intraday';

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function toDateStr(ms) {
  // IST calendar date (matches bar_aggregator.js's istDateStr convention)
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function parseCandles(body) {
  if (body.status !== 'success') throw new Error(`Upstox status: ${body.status}`);
  return (body.data.candles || [])
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), close: c[4] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

/** Fetches 1-min candles for [fromDateStr, toDateStr] (inclusive, YYYY-MM-DD, IST calendar dates). */
async function fetchHistoricalRange(token, instrumentKey, fromDateStr, toDateStr) {
  const url = `${HISTORICAL_RANGE_BASE}/${encodeURIComponent(instrumentKey)}/minutes/1/${toDateStr}/${fromDateStr}`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching historical range for ${instrumentKey}`);
  return parseCandles(await res.json());
}

/** Fetches today-so-far 1-min candles (same endpoint the sibling DarvasBox streamer already uses). */
async function fetchTodaysCandles(token, instrumentKey) {
  const url = `${HISTORICAL_INTRADAY_BASE}/${encodeURIComponent(instrumentKey)}/minutes/1`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching today's candles for ${instrumentKey}`);
  return parseCandles(await res.json());
}

/**
 * Returns candles strictly after lastKnownMs, up to (and including) today,
 * for the gap between a seed CSV's last timestamp and now. Empty result is
 * normal (weekend/holiday gap, or already caught up) -- not an error.
 */
async function fillGap(token, instrumentKey, lastKnownMs) {
  const nowMs = Date.now();
  const fromDateStr = toDateStr(lastKnownMs);
  const toDateStrToday = toDateStr(nowMs);

  let rangeCandles = [];
  if (fromDateStr < toDateStrToday) {
    // Date-ranged endpoint's `to_date` is exclusive of "today" in practice for intraday
    // granularity (today's still-forming session isn't a settled historical day yet) --
    // so today itself is always fetched separately via fetchTodaysCandles below.
    const dayBeforeToday = new Date(nowMs - 24 * 60 * 60 * 1000);
    const toDateStrRange = toDateStr(dayBeforeToday.getTime());
    if (fromDateStr <= toDateStrRange) {
      rangeCandles = await fetchHistoricalRange(token, instrumentKey, fromDateStr, toDateStrRange);
    }
  }

  const todaysCandles = await fetchTodaysCandles(token, instrumentKey);
  const merged = [...rangeCandles, ...todaysCandles]
    .filter((c) => c.timestampMs > lastKnownMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  // de-dup (range and today-so-far endpoints could theoretically overlap at the boundary)
  const seen = new Set();
  return merged.filter((c) => {
    if (seen.has(c.timestampMs)) return false;
    seen.add(c.timestampMs);
    return true;
  });
}

module.exports = { fillGap, fetchHistoricalRange, fetchTodaysCandles };
