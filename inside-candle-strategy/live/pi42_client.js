'use strict';

/**
 * Pi42 public, UNAUTHENTICATED REST client. Used only for history-seeding
 * klines at startup. No API key, no signed requests -- this build is
 * alert-only and deliberately contains zero authenticated Pi42 request code,
 * same boundary as ichimoku-btc-xau-strategy/live/pi42_client.js (this file
 * is a straight copy of that one -- generic, not strategy-specific).
 *
 * Reference: /Users/adilrizwan/Downloads/second brain/wiki/reference/pi42-api.md
 *   POST https://api.pi42.com/v1/market/klines
 *   body: { pair, interval, limit, startTime?, endTime? }
 *   query: priceType=MARK_PRICE | LAST_PRICE
 *   Public rate limit: 60 req/min (comfortably fine for a couple of startup
 *   seed calls per symbol).
 */

const BASE_URL = 'https://api.pi42.com';
// Bug fix (2026-08-26, caught via a user screenshot of Pi42's own chart widget, which has
// separate "Mark Price" / "Last Traded Price" tabs): the kline WEBSOCKET topic
// (`{pair}@kline_{interval}`, used for all LIVE data once seeding is done) is a distinct
// stream from `{pair}@markPrice` -- standard exchange convention (Binance/Bybit etc. all keep
// kline == trade/last-price candles separate from a dedicated mark-price stream) -- so it is
// almost certainly Last Traded Price, not Mark Price. This REST client's history-seed call was
// defaulting to MARK_PRICE, meaning the bot's seeded history and its live-streamed data were two
// different price series stitched together at startup. Fixed to default LAST_PRICE so the seed
// matches what the live stream actually delivers.
const PRICE_TYPE = process.env.PI42_PRICE_TYPE || 'LAST_PRICE';

/**
 * Fetch `limit` completed candles for `pair`/`interval` (e.g. "BTCINR","15m").
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
  // Empirically (per ichimoku-btc-xau-strategy), Pi42 sometimes ignores `limit` and returns
  // its own default page size -- trim to what was actually asked for so seed depth stays
  // predictable, keeping the most recent bars.
  return bars.length > limit ? bars.slice(bars.length - limit) : bars;
}

module.exports = { fetchKlines, BASE_URL, PRICE_TYPE };
