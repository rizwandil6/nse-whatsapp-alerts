'use strict';
/** Fetches 5-min candles for the full 23-stock watchlist over the trailing 52 weeks
 * (2025-07-23 to 2026-07-22), for the "52-week report" ask. Same 1-minute-chunked
 * fetch + 5-min aggregation pattern used elsewhere in this project. */
const fs = require('fs');
const path = require('path');

const TOKEN = fs.readFileSync('/Users/adilrizwan/Downloads/nse-whatsapp-alerts/.secrets/upstox_token.txt', 'utf8').trim();
const OUT_PATH = path.join(__dirname, 'watchlist_52w_cache.json');
const IST_OFFSET_MS = 5.5 * 3600000;
const MARKET_OPEN_MIN = 9 * 60 + 15;

const KEYS = {
  CONCOR: 'NSE_EQ|INE111A01025',
  HATHWAY: 'NSE_EQ|INE982F01036',
  NHPC: 'NSE_EQ|INE848E01016',
  JSWINFRA: 'NSE_EQ|INE880J01026',
  JKIL: 'NSE_EQ|INE576I01022',
  SUZLON: 'NSE_EQ|INE040H01021',
  WAAREEENER: 'NSE_EQ|INE377N01017',
  OLAELEC: 'NSE_EQ|INE0LXG01040',
  HINDCOPPER: 'NSE_EQ|INE531E01026',
  MHRIL: 'NSE_EQ|INE998I01010',
  RVNL: 'NSE_EQ|INE415G01027',
  RAILTEL: 'NSE_EQ|INE0DD101019',
  GAIL: 'NSE_EQ|INE129A01019',
  ADSL: 'NSE_EQ|INE102I01027',
  'ARE&M': 'NSE_EQ|INE885A01032',
  NCC: 'NSE_EQ|INE868B01028',
  STERTOOLS: 'NSE_EQ|INE334A01023',
  TEXRAIL: 'NSE_EQ|INE621L01012',
  TITAGARH: 'NSE_EQ|INE615H01020',
  MANINDS: 'NSE_EQ|INE993A01026',
  SERVOTECH: 'NSE_EQ|INE782X01033',
  IRCON: 'NSE_EQ|INE962Y01021',
  TRITURBINE: 'NSE_EQ|INE152M01016',
};

const FROM = '2025-07-23';
const TO = '2026-07-22';

function istMin(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function istDate(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

async function fetchOneMin(instrumentKey, from, to) {
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/1minute/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`status: ${body.status}`);
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
    try {
      const part = await fetchOneMin(instrumentKey, from, to);
      all = all.concat(part);
    } catch (e) {
      console.warn(`  chunk ${from}..${to} failed: ${e.message}`);
    }
    await sleep(120);
  }
  all.sort((a, b) => a.timestampMs - b.timestampMs);
  return aggregateTo5Min(all);
}

async function main() {
  const cache = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : {};
  for (const [symbol, key] of Object.entries(KEYS)) {
    if (cache[symbol] && cache[symbol].fiveMin && cache[symbol].fiveMin.length > 3000) {
      console.log(`${symbol}: already cached (${cache[symbol].fiveMin.length}), skipping`);
      continue;
    }
    try {
      const fiveMin = await fetchFiveMinFor(key);
      cache[symbol] = { fiveMin };
      fs.writeFileSync(OUT_PATH, JSON.stringify(cache));
      console.log(`${symbol}: ${fiveMin.length} 5-min candles`);
    } catch (e) {
      console.warn(`FAILED ${symbol}: ${e.message}`);
    }
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(cache));
  console.log('Done ->', OUT_PATH);
}
main();
