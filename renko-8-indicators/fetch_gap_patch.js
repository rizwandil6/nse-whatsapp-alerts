'use strict';
/** Patches the single chunk (2026-02-23..2026-03-24) that consistently 400'd
 * during fetch_watchlist_52w.js -- splitting it into two smaller sub-ranges
 * fixed it (verified via direct curl test). Merges results into the same
 * cache file, re-sorting/re-aggregating each symbol's full fiveMin series. */
const fs = require('fs');
const path = require('path');

const TOKEN = fs.readFileSync('/Users/adilrizwan/Downloads/nse-whatsapp-alerts/.secrets/upstox_token.txt', 'utf8').trim();
const OUT_PATH = path.join(__dirname, 'watchlist_52w_cache.json');
const IST_OFFSET_MS = 5.5 * 3600000;
const MARKET_OPEN_MIN = 9 * 60 + 15;

const KEYS = {
  CONCOR: 'NSE_EQ|INE111A01025', HATHWAY: 'NSE_EQ|INE982F01036', NHPC: 'NSE_EQ|INE848E01016',
  JSWINFRA: 'NSE_EQ|INE880J01026', JKIL: 'NSE_EQ|INE576I01022', SUZLON: 'NSE_EQ|INE040H01021',
  WAAREEENER: 'NSE_EQ|INE377N01017', OLAELEC: 'NSE_EQ|INE0LXG01040', HINDCOPPER: 'NSE_EQ|INE531E01026',
  MHRIL: 'NSE_EQ|INE998I01010', RVNL: 'NSE_EQ|INE415G01027', RAILTEL: 'NSE_EQ|INE0DD101019',
  GAIL: 'NSE_EQ|INE129A01019', ADSL: 'NSE_EQ|INE102I01027', 'ARE&M': 'NSE_EQ|INE885A01032',
  NCC: 'NSE_EQ|INE868B01028', STERTOOLS: 'NSE_EQ|INE334A01023', TEXRAIL: 'NSE_EQ|INE621L01012',
  TITAGARH: 'NSE_EQ|INE615H01020', MANINDS: 'NSE_EQ|INE993A01026', SERVOTECH: 'NSE_EQ|INE782X01033',
  IRCON: 'NSE_EQ|INE962Y01021', TRITURBINE: 'NSE_EQ|INE152M01016',
};

function istMin(ms) { const d = new Date(ms + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function istDate(ms) { return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10); }

async function fetchOneMin(instrumentKey, from, to) {
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/1minute/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`status: ${body.status} ${JSON.stringify(body.errors || '')}`);
  return (body.data.candles || [])
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function aggregateTo5Min(oneMin) {
  const buckets = new Map();
  for (const c of oneMin) {
    const min = istMin(c.timestampMs);
    if (min < MARKET_OPEN_MIN) continue;
    const day = istDate(c.timestampMs);
    const idx = Math.floor((min - MARKET_OPEN_MIN) / 5);
    const key = `${day}#${idx}`;
    if (!buckets.has(key)) buckets.set(key, { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, timestampMs: c.timestampMs });
    else { const b = buckets.get(key); b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; b.volume += c.volume; }
  }
  return [...buckets.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const cache = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  for (const [symbol, key] of Object.entries(KEYS)) {
    try {
      const part1 = await fetchOneMin(key, '2026-02-23', '2026-03-08');
      await sleep(120);
      const part2 = await fetchOneMin(key, '2026-03-09', '2026-03-24');
      await sleep(120);
      const patchFive = aggregateTo5Min(part1.concat(part2));
      const existing = cache[symbol].fiveMin;
      const merged = existing.concat(patchFive).sort((a, b) => a.timestampMs - b.timestampMs);
      // de-dupe by timestamp in case of overlap
      const deduped = [];
      let lastTs = null;
      for (const c of merged) {
        if (c.timestampMs !== lastTs) deduped.push(c);
        lastTs = c.timestampMs;
      }
      cache[symbol] = { fiveMin: deduped };
      console.log(`${symbol}: patched +${patchFive.length}, total ${deduped.length}`);
    } catch (e) {
      console.warn(`FAILED ${symbol}: ${e.message}`);
    }
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(cache));
  console.log('Done ->', OUT_PATH);
}
main();
