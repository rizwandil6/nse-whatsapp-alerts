'use strict';
/** Fetches ORIENTELEC 5-min candles matching watchlist_cache.json's existing date range, appends to it (doesn't touch other symbols already cached). */
const fs = require('fs');
const path = require('path');

const TOKEN = fs.readFileSync('/Users/adilrizwan/Downloads/nse-whatsapp-alerts/.secrets/upstox_token.txt', 'utf8').trim();
const UPSTOX_BASE = 'https://api.upstox.com/v2';
const OUT_PATH = path.join(__dirname, 'watchlist_cache.json');

const SYMBOL = 'ORIENTELEC';
const INSTRUMENT_KEY = 'NSE_EQ|INE142Z01019';
const FROM = '2026-05-21';
const TO = '2026-07-20';
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MARKET_OPEN_MIN = 9 * 60 + 15;

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
  const existing = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : {};
  try {
    const fiveMin = await fetchFiveMinFor(INSTRUMENT_KEY);
    existing[SYMBOL] = { fiveMin };
    console.log(`${SYMBOL}: ${fiveMin.length} 5-min candles`);
    fs.writeFileSync(OUT_PATH, JSON.stringify(existing));
    console.log('Written', OUT_PATH);
  } catch (e) {
    console.error(`FAILED ${SYMBOL}:`, e.message);
    process.exit(1);
  }
}

main();
