'use strict';

// Rebuilds src/main/resources/dashboard/data/sector-seasonality.json from
// sector_candle_cache.json (run fetch_sectors.js first to refresh that cache)
// plus a fresh Nifty 50 benchmark pulled from Yahoo Finance. Run this any
// time the sector cache is refreshed so the Seasonality dashboard tab picks
// up the new months -- it's a static bundled resource, not a live feed (see
// DashboardDataController.seasonality()), so redeploying is required after.

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, 'sector_candle_cache.json');
const OUT_PATH = path.join(__dirname, '..', 'src', 'main', 'resources', 'dashboard', 'data', 'sector-seasonality.json');
const BENCHMARK_KEY = 'Nifty 50';

function monthlyReturnsFromCandles(candles) {
  const closeByMonth = new Map();
  for (const c of candles) {
    const d = new Date(c.timestampMs);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
    closeByMonth.set(key, c.close); // candles are chronological -> last write wins
  }
  const keys = [...closeByMonth.keys()].map((k) => {
    const [y, m] = k.split('-').map(Number);
    return { y, m, close: closeByMonth.get(k) };
  }).sort((a, b) => (a.y - b.y) || (a.m - b.m));

  const out = [];
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1], cur = keys[i];
    const expectedMonth = (prev.m % 12) + 1;
    const expectedYear = prev.m === 12 ? prev.y + 1 : prev.y;
    if (cur.m === expectedMonth && cur.y === expectedYear) {
      out.push({ y: cur.y, m: cur.m, r: Math.round((cur.close / prev.close - 1) * 10000) / 100 });
    }
  }
  return out;
}

async function fetchNifty50Monthly() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=10y';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);
  const body = await res.json();
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo Finance: no chart result');
  const { timestamp, indicators } = result;
  const closes = indicators.quote[0].close;
  const candles = timestamp
    .map((t, i) => ({ timestampMs: t * 1000, close: closes[i] }))
    .filter((c) => c.close != null);
  return monthlyReturnsFromCandles(candles);
}

async function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const sectors = {};
  for (const [sector, candles] of Object.entries(cache)) {
    sectors[sector] = monthlyReturnsFromCandles(candles);
  }

  console.log('Fetching Nifty 50 benchmark from Yahoo Finance...');
  sectors[BENCHMARK_KEY] = await fetchNifty50Monthly();

  const payload = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: 'sector data: swing-strategy/sector_candle_cache.json (Upstox monthly candles); Nifty 50 benchmark: Yahoo Finance ^NSEI',
    sectors,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload));
  console.log(`Wrote ${OUT_PATH}`);
  for (const [k, v] of Object.entries(sectors)) {
    console.log(`  ${k}: ${v.length} monthly returns, latest ${JSON.stringify(v[v.length - 1])}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
