'use strict';

const UPSTOX_BASE = 'https://api.upstox.com/v2';

/** Fetches [from,to] (YYYY-MM-DD) candles at the given interval, ascending by time. */
async function fetchCandles(instrumentKey, interval, from, to, token) {
  const url = `${UPSTOX_BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/${interval}/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${instrumentKey}/${interval}`);
  const body = await res.json();
  const raw = body?.data?.candles || [];
  return raw
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

module.exports = { fetchCandles, isoDate };
