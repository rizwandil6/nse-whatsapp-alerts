'use strict';

/**
 * Pi42 public, UNAUTHENTICATED REST client. Used only for history-seeding
 * klines at startup. No API key, no signed requests -- this build is
 * alert-only and deliberately contains zero authenticated Pi42 request code
 * (see README "Execution — a deliberately separate future phase").
 *
 * Reference: /Users/adilrizwan/Downloads/second brain/wiki/reference/pi42-api.md
 *   POST https://api.pi42.com/v1/market/klines
 *   body: { pair, interval, limit, startTime?, endTime? }
 *   query: priceType=MARK_PRICE | LAST_PRICE
 *   Public rate limit: 60 req/min (comfortably fine for a couple of startup
 *   seed calls per symbol).
 */

const BASE_URL = 'https://api.pi42.com';
const PRICE_TYPE = process.env.PI42_PRICE_TYPE || 'MARK_PRICE';

/**
 * Fetch `limit` completed candles for `pair`/`interval` (e.g. "BTCUSDT","5m").
 * Returns bars oldest-first: { timestampMs, open, high, low, close, volume }.
 */
async function fetchKlines(pair, interval, limit) {
  const url = `${BASE_URL}/v1/market/klines?priceType=${encodeURIComponent(PRICE_TYPE)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pair, interval, limit }),
  });
  if (!res.ok) throw new Error(`Pi42 klines failed for ${pair} ${interval}: HTTP ${res.status} — ${await res.text()}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Pi42 klines: unexpected response shape for ${pair} ${interval}`);
  const bars = data
    .map((c) => ({
      timestampMs: Number(c.startTime),
      open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
      volume: Number(c.volume || 0),
    }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
  // Empirically, Pi42 sometimes ignores `limit` and returns its own default page size
  // (observed: 500 regardless of a requested 100/300) -- trim to what was actually asked
  // for so seed depth stays predictable, keeping the most recent bars.
  return bars.length > limit ? bars.slice(bars.length - limit) : bars;
}

module.exports = { fetchKlines, BASE_URL, PRICE_TYPE };
