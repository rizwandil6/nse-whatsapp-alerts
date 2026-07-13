'use strict';

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = '/private/tmp/claude-501/-Users-adilrizwan-Downloads/fef5c952-3a52-453b-aac2-05d44213f064/scratchpad/.secrets/upstox_token.txt';
const TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const OUT_PATH = path.join(__dirname, 'sector_candle_cache.json');

const sectorMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'sector_map.json'), 'utf8'));
const sectors = [...new Set(Object.values(sectorMap))];

async function fetchMonthly(indexName, from, to) {
  const instrumentKey = `NSE_INDEX|${indexName}`;
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/month/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${indexName}`);
  const body = await res.json();
  const raw = body?.data?.candles || [];
  return raw
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

async function main() {
  const cache = {};
  for (const sector of sectors) {
    try {
      console.log(`Fetching ${sector}...`);
      const candles = await fetchMonthly(sector, '2016-07-10', '2026-07-09');
      cache[sector] = candles;
      console.log(`  -> ${candles.length} monthly candles`);
    } catch (e) {
      console.warn(`  FAILED ${sector}: ${e.message}`);
    }
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(cache));
  console.log(`\nDone. ${Object.keys(cache).length}/${sectors.length} sector indices cached.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
