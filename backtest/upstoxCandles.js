'use strict';

const UPSTOX_BASE = 'https://api.upstox.com/v2';

/** Fetches 1-minute candles [fromDate, toDate] (YYYY-MM-DD) for an instrument, ascending by time. */
async function fetchCandles(instrumentKey, fromDate, toDate, token) {
  const url = `${UPSTOX_BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/1minute/${toDate}/${fromDate}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Upstox historical-candle HTTP ${res.status} for ${instrumentKey}`);
  }
  const body = await res.json();
  const raw = body?.data?.candles || [];
  // Upstox candle shape: [timestampIso, open, high, low, close, volume, oi]
  // Returned NEWEST FIRST — reverse to ascending for the simulator.
  return raw
    .map((c) => ({
      timestampMs: new Date(c[0]).getTime(),
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
    }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

module.exports = { fetchCandles, isoDate };
