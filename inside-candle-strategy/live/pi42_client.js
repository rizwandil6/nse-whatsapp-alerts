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
 * Optional `startTime`/`endTime` (ms) page a specific historical window -- used by
 * fetchKlinesRange() below for backtest history beyond the ~1500-bar single-call cap Pi42
 * empirically enforces (confirmed 2026-08-28: requesting limit>1500 silently still returns 1500).
 * Returns bars oldest-first: { timestampMs, open, high, low, close, volume }.
 */
async function fetchKlines(pair, interval, limit, { startTime, endTime } = {}) {
  const url = `${BASE_URL}/v1/market/klines?priceType=${encodeURIComponent(PRICE_TYPE)}`;
  const body = { pair, interval, limit };
  if (startTime != null) body.startTime = startTime;
  if (endTime != null) body.endTime = endTime;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

/**
 * Page backwards from `endTime` (default: now) to assemble `totalBars` 1-min (or other interval)
 * candles beyond the single-call cap, for backtesting only (the live bot only ever needs a small
 * seed window, via plain fetchKlines). Walks endTime back by 1500-bar chunks each request,
 * respecting Pi42's public 60 req/min rate limit with a small inter-request delay. Deduplicates
 * on timestampMs in case of any page-boundary overlap.
 */
async function fetchKlinesRange(pair, interval, totalBars, { endTime, delayMs = 350 } = {}) {
  const intervalMs = { '1m': 60000, '15m': 15 * 60000 }[interval];
  if (!intervalMs) throw new Error(`fetchKlinesRange: unsupported interval ${interval}`);
  const PAGE = 1500;
  const byTs = new Map();
  let cursor = endTime || Date.now();
  let remaining = totalBars;
  while (remaining > 0) {
    const pageLimit = Math.min(PAGE, remaining + 5); // small overlap buffer, deduped below
    const pageStart = cursor - pageLimit * intervalMs;
    const bars = await fetchKlines(pair, interval, pageLimit, { startTime: pageStart, endTime: cursor });
    if (!bars.length) break; // no more history available
    for (const b of bars) byTs.set(b.timestampMs, b);
    cursor = bars[0].timestampMs - 1; // page further back, just before the oldest bar received
    remaining -= bars.length;
    if (bars.length < pageLimit) break; // exchange ran out of history for this pair/interval
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return Array.from(byTs.values()).sort((a, b) => a.timestampMs - b.timestampMs);
}

module.exports = { fetchKlines, fetchKlinesRange, BASE_URL, PRICE_TYPE };
