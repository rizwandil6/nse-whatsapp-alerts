'use strict';

/**
 * Fetches each symbol's PREVIOUS trading day high/low (PDH/PDL) from Upstox's
 * historical daily-candle endpoint, at startup. Uses the same
 * UPSTOX_ACCESS_TOKEN the streamer already needs.
 *
 *   GET /v2/historical-candle/{instrument_key}/day/{to}/{from}
 *   candles: [ [ts, open, high, low, close, volume, oi], ... ]  (latest first)
 *
 * We take the most recent candle whose IST date is NOT today — i.e. the last
 * completed session — so PDH/PDL are correct whether the process starts
 * pre-open or intraday.
 */

const IST_OFFSET_MS = 5.5 * 3600000;

function istDateStr(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function ymd(d) { return d.toISOString().slice(0, 10); }

async function fetchOne(symbol, key, token) {
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 12 * 86400000));
  const ek = encodeURIComponent(key);
  const url = `https://api.upstox.com/v2/historical-candle/${ek}/day/${to}/${from}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'pdh-pdl-scanner/1.0', Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const candles = body && body.data && body.data.candles;
  if (!Array.isArray(candles) || candles.length === 0) throw new Error('no candles');
  const today = istDateStr(Date.now());
  // candles are latest-first; find the most recent one that isn't today.
  // Format: [ts, open, high, low, close, volume, oi] — close (c[4]) is pdc, for the v3 gap test.
  for (const c of candles) {
    const d = String(c[0]).slice(0, 10);
    if (d !== today) return { pdh: c[2], pdl: c[3], pdc: c[4], date: d };
  }
  // all candles are "today" (shouldn't happen for a daily series) -> fall back to newest
  const c = candles[0];
  return { pdh: c[2], pdl: c[3], pdc: c[4], date: String(c[0]).slice(0, 10) };
}

/** Returns { symbol: {pdh, pdl, date} }, plus a list of symbols that failed. */
async function fetchLevels(symbolMap, token, concurrency = 4) {
  const entries = Object.entries(symbolMap);
  const out = {};
  const failed = [];
  let i = 0;
  async function worker() {
    while (i < entries.length) {
      const [symbol, key] = entries[i++];
      for (let att = 0; att < 4; att++) {
        try { out[symbol] = await fetchOne(symbol, key, token); break; }
        catch (e) {
          if (att === 3) { failed.push(symbol); console.warn(`  PDH/PDL fetch failed for ${symbol}: ${e.message}`); }
          else await new Promise((r) => setTimeout(r, 1000 * (att + 1)));
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { levels: out, failed };
}

module.exports = { fetchLevels };
