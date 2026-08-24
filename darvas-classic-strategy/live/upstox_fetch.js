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

const MAX_RETRIES = 4;
const RETRY_BASE_MS = 2000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Fetches [from,to] (YYYY-MM-DD) daily candles, ascending by time. Retries on HTTP 429 with backoff. */
async function fetchDailyCandles(instrumentKey, from, to) {
  const url = `${UPSTOX_BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/day/${to}/${from}`;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (res.ok) {
      const body = await res.json();
      const raw = body?.data?.candles || [];
      return raw
        .map((c) => ({ date: c[0].slice(0, 10), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
    }
    lastErr = new Error(`HTTP ${res.status} for ${instrumentKey}`);
    if (res.status !== 429 || attempt === MAX_RETRIES) throw lastErr;
    await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
  }
  throw lastErr;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Today's intraday candles (interval: '1minute' or '30minute') via Upstox's
 * DEDICATED unauthenticated intraday endpoint -- NOT the date-ranged
 * historical-candle path (confirmed live 2026-08-24: that one returns an
 * empty candle array for today even mid-market-hours; it only serves
 * completed past days). This one takes no date params at all and returns
 * today's candles as they form. No access token needed.
 */
async function fetchIntradayCandles(instrumentKey, interval) {
  const url = `${UPSTOX_BASE}/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${interval}`;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (res.ok) {
      const body = await res.json();
      const raw = body?.data?.candles || [];
      return raw
        .map((c) => ({ timestampIso: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
        .sort((a, b) => (a.timestampIso < b.timestampIso ? -1 : 1));
    }
    lastErr = new Error(`HTTP ${res.status} for ${instrumentKey}`);
    if (res.status !== 429 || attempt === MAX_RETRIES) throw lastErr;
    await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
  }
  throw lastErr;
}

module.exports = { fetchDailyCandles, fetchIntradayCandles, isoDate };
