'use strict';
/**
 * Fetches 5-min candles per portfolio symbol from (that symbol's actual buy
 * date - 90 calendar days warm-up) through today -- unlike watchlist_cache.json,
 * which uses one uniform ~60-day window for every symbol regardless of when it
 * was actually bought. Separate cache file so it doesn't disturb the existing
 * uniform-window backtests.
 */
const fs = require('fs');
const path = require('path');

const TOKEN = fs.readFileSync('/Users/adilrizwan/Downloads/nse-whatsapp-alerts/.secrets/upstox_token.txt', 'utf8').trim();
const UPSTOX_BASE = 'https://api.upstox.com/v2';
const OUT_PATH = path.join(__dirname, 'portfolio_since_buy_cache.json');
const TODAY = '2026-07-23';
const WARMUP_DAYS = 90;

const SYMBOLS = {
  CONCOR: { key: 'NSE_EQ|INE111A01025', buyDate: '2025-07-11' },
  GAIL: { key: 'NSE_EQ|INE129A01019', buyDate: '2025-06-12' },
  HATHWAY: { key: 'NSE_EQ|INE982F01036', buyDate: '2025-07-25' },
  HINDCOPPER: { key: 'NSE_EQ|INE531E01026', buyDate: '2026-01-30' },
  JKIL: { key: 'NSE_EQ|INE576I01022', buyDate: '2025-07-30' },
  JSWINFRA: { key: 'NSE_EQ|INE880J01026', buyDate: '2025-07-25' },
  MANINDS: { key: 'NSE_EQ|INE993A01026', buyDate: '2026-06-18' },
  MHRIL: { key: 'NSE_EQ|INE998I01010', buyDate: '2025-07-24' },
  NHPC: { key: 'NSE_EQ|INE848E01016', buyDate: '2025-07-15' },
  OLAELEC: { key: 'NSE_EQ|INE0LXG01040', buyDate: '2026-06-09' },
  ORIENTELEC: { key: 'NSE_EQ|INE142Z01019', buyDate: '2026-04-29' },
  RAILTEL: { key: 'NSE_EQ|INE0DD101019', buyDate: '2025-06-12' },
  RVNL: { key: 'NSE_EQ|INE415G01027', buyDate: '2025-07-15' },
  SUZLON: { key: 'NSE_EQ|INE040H01021', buyDate: '2025-11-06' },
  WAAREEENER: { key: 'NSE_EQ|INE377N01017', buyDate: '2025-09-12' },
  ADSL: { key: 'NSE_EQ|INE102I01027', buyDate: '2025-01-16' },
  'ARE&M': { key: 'NSE_EQ|INE885A01032', buyDate: '2025-01-16' },
  NCC: { key: 'NSE_EQ|INE868B01028', buyDate: '2025-01-16' },
  STERTOOLS: { key: 'NSE_EQ|INE334A01023', buyDate: '2025-01-16' },
  TEXRAIL: { key: 'NSE_EQ|INE621L01012', buyDate: '2025-01-16' },
  TITAGARH: { key: 'NSE_EQ|INE615H01020', buyDate: '2025-01-28' },
};

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

function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function fetchFiveMinFor(instrumentKey, fromDateStr, toDateStr) {
  const chunks = [];
  let chunkTo = new Date(toDateStr + 'T00:00:00Z');
  const fromDate = new Date(fromDateStr + 'T00:00:00Z');
  while (chunkTo >= fromDate) {
    const chunkFrom = new Date(chunkTo);
    chunkFrom.setUTCDate(chunkFrom.getUTCDate() - 29);
    const from = (chunkFrom < fromDate ? fromDate : chunkFrom).toISOString().slice(0, 10);
    const to = chunkTo.toISOString().slice(0, 10);
    chunks.push({ from, to });
    chunkTo = new Date(chunkFrom);
    chunkTo.setUTCDate(chunkTo.getUTCDate() - 1);
  }
  let all = [];
  for (const { from, to } of chunks) {
    try {
      const part = await fetchCandles(instrumentKey, from, to);
      all = all.concat(part);
    } catch (e) {
      console.warn(`    chunk ${from}..${to} failed: ${e.message}`);
    }
    await sleep(150);
  }
  all.sort((a, b) => a.timestampMs - b.timestampMs);
  return aggregateTo5Min(all);
}

async function main() {
  const out = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : {};
  for (const [symbol, { key, buyDate }] of Object.entries(SYMBOLS)) {
    const fromDate = addDays(buyDate, -WARMUP_DAYS);
    console.log(`${symbol}: fetching ${fromDate} .. ${TODAY} (buy date ${buyDate})...`);
    try {
      const fiveMin = await fetchFiveMinFor(key, fromDate, TODAY);
      out[symbol] = { fiveMin, buyDate, fetchFrom: fromDate };
      console.log(`  ${symbol}: ${fiveMin.length} 5-min candles`);
      fs.writeFileSync(OUT_PATH, JSON.stringify(out));
    } catch (e) {
      console.warn(`  FAILED ${symbol}: ${e.message}`);
    }
  }
  console.log('Written', OUT_PATH);
}

main();
