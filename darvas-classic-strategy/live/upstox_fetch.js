'use strict';

/**
 * Unauthenticated Upstox v2 historical-candle fetch. Upstox's *historical*
 * (not intraday) candle endpoint serves past dates without an access token
 * -- confirmed working, but the default Node/urllib User-Agent gets
 * blocked, so a browser-like one is required. No UPSTOX_ACCESS_TOKEN
 * dependency for this service.
 */

const UPSTOX_BASE = 'https://api.upstox.com/v2';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Fetches [from,to] (YYYY-MM-DD) daily candles, ascending by time. */
async function fetchDailyCandles(instrumentKey, from, to) {
  const url = `${UPSTOX_BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/day/${to}/${from}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${instrumentKey}`);
  const body = await res.json();
  const raw = body?.data?.candles || [];
  return raw
    .map((c) => ({ date: c[0].slice(0, 10), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

module.exports = { fetchDailyCandles, isoDate };
