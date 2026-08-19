'use strict';

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '..', '.secrets', 'upstox_token.txt');
const TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const OUT_PATH = path.join(__dirname, 'sector_candle_cache.json');

const sectorMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'sector_map.json'), 'utf8'));
const sectors = [...new Set(Object.values(sectorMap))];

async function fetchMonthly(indexName, from, to) {
  // v2's /historical-candle/.../month/... now rejects every range with UDAPI1148
  // "Invalid date range" (tested 2026-08-19, no error was ever specific about why) --
  // Upstox's v3 historical-candle API (unit="months", interval="1") works with the
  // exact same date range and returns the same [ts, o, h, l, c, vol, oi] candle shape,
  // just newest-first and ISO-timestamped instead of oldest-first/date-only. Switched
  // wholesale rather than chase what changed in v2.
  const instrumentKey = `NSE_INDEX|${indexName}`;
  const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentKey)}/months/1/${to}/${from}`;
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
      const candles = await fetchMonthly(sector, '2016-07-10', new Date().toISOString().slice(0, 10));
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
