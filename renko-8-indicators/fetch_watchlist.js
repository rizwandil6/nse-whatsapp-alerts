'use strict';
/**
 * Fetches 5-min candles for the user's pasted watchlist, matching the same
 * date range/format as renko-strategy/intraday_cache.json's fiveMin arrays,
 * for the symbols NOT already present in that cache. Fresh fetch script for
 * this directory -- reuses only the Upstox historical-candle REST pattern
 * already used elsewhere in this project (a public API convention, not
 * borrowed strategy code).
 */
const fs = require('fs');
const path = require('path');

const TOKEN = fs.readFileSync('/Users/adilrizwan/Downloads/nse-whatsapp-alerts/.secrets/upstox_token.txt', 'utf8').trim();
const UPSTOX_BASE = 'https://api.upstox.com/v2';
const OUT_PATH = path.join(__dirname, 'watchlist_cache.json');

const NEW_SYMBOLS = {
  HATHWAY: 'NSE_EQ|INE982F01036',
  NHPC: 'NSE_EQ|INE848E01016',
  JSWINFRA: 'NSE_EQ|INE880J01026',
  JKIL: 'NSE_EQ|INE576I01022',
  OLAELEC: 'NSE_EQ|INE0LXG01040',
  MHRIL: 'NSE_EQ|INE998I01010',
  ADSL: 'NSE_EQ|INE102I01027',
  STERTOOLS: 'NSE_EQ|INE334A01023',
  TEXRAIL: 'NSE_EQ|INE621L01012',
  MANINDS: 'NSE_EQ|INE993A01026',
  SERVOTECH: 'NSE_EQ|INE782X01033',
};

const FROM = '2026-05-21';
const TO = '2026-07-20';
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MARKET_OPEN_MIN = 9 * 60 + 15;

// v2 historical-candle only accepts 1minute for sub-day granularity (confirmed via
// a live error response: "Interval accepts one of (1minute,30minute,day,week,month)"),
// and caps 1-minute requests at ~30 calendar days per call -- fetch in chunks and
// aggregate to 5-min ourselves, same general Upstox API constraints this whole
// project already works within elsewhere (not specific borrowed strategy code).
async function fetchCandles(instrumentKey, from, to) {
  const url = `${UPSTOX_BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/1minute/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`status: ${body.status} ${JSON.stringify(body.errors || '')}`);
  return (body.data.candles || [])
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function istMinutesOfDay(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function istDateStr(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

function aggregateTo5Min(oneMinCandles) {
  const buckets = new Map();
  for (const c of oneMinCandles) {
    const min = istMinutesOfDay(c.timestampMs);
    const day = istDateStr(c.timestampMs);
    const bucketIdx = Math.floor((min - MARKET_OPEN_MIN) / 5);
    const key = `${day}#${bucketIdx}`;
    if (!buckets.has(key)) {
      buckets.set(key, { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, timestampMs: c.timestampMs });
    } else {
      const b = buckets.get(key);
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchFiveMinFor(instrumentKey) {
  const chunks = [];
  let chunkTo = new Date(TO + 'T00:00:00Z');
  const fromDate = new Date(FROM + 'T00:00:00Z');
  while (chunkTo >= fromDate) {
    const chunkFrom = new Date(chunkTo);
    chunkFrom.setDate(chunkFrom.getDate() - 29);
    const from = (chunkFrom < fromDate ? fromDate : chunkFrom).toISOString().slice(0, 10);
    const to = chunkTo.toISOString().slice(0, 10);
    chunks.push({ from, to });
    chunkTo = new Date(chunkFrom);
    chunkTo.setDate(chunkTo.getDate() - 1);
  }
  let all = [];
  for (const { from, to } of chunks) {
    const part = await fetchCandles(instrumentKey, from, to);
    all = all.concat(part);
    await sleep(150);
  }
  all.sort((a, b) => a.timestampMs - b.timestampMs);
  return aggregateTo5Min(all);
}

async function main() {
  const out = {};
  for (const [symbol, key] of Object.entries(NEW_SYMBOLS)) {
    try {
      const fiveMin = await fetchFiveMinFor(key);
      out[symbol] = { fiveMin };
      console.log(`${symbol}: ${fiveMin.length} 5-min candles`);
    } catch (e) {
      console.warn(`FAILED ${symbol}: ${e.message}`);
    }
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log('Written', OUT_PATH);
}

main();
