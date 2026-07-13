'use strict';

/**
 * Fetches Daily/Weekly/Monthly candles for any of the 353-stock halal
 * universe not yet present in mtf_candle_cache.json (idempotent — safe to
 * re-run, skips symbols already cached).
 */

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = '/private/tmp/claude-501/-Users-adilrizwan-Downloads/fef5c952-3a52-453b-aac2-05d44213f064/scratchpad/.secrets/upstox_token.txt';
const CACHE_PATH = path.join(__dirname, 'mtf_candle_cache.json');
const FULL_353_PATH = path.join(__dirname, '..', 'ema-scalp-strategy', 'symbols.json');

const TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const symbolMap = JSON.parse(fs.readFileSync(FULL_353_PATH, 'utf8'));
const UPSTOX_BASE = 'https://api.upstox.com/v2';

const RANGES = {
  day: { from: '2021-07-10', to: '2026-07-09' },
  week: { from: '2021-07-10', to: '2026-07-09' },
  month: { from: '2016-07-10', to: '2026-07-09' },
};

async function fetchCandles(instrumentKey, interval, from, to) {
  const url = `${UPSTOX_BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/${interval}/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${instrumentKey}/${interval}`);
  const body = await res.json();
  const raw = body?.data?.candles || [];
  return raw
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

async function main() {
  let cache = {};
  if (fs.existsSync(CACHE_PATH)) cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));

  const toFetch = Object.entries(symbolMap).filter(([symbol]) => !cache[symbol]);
  console.log(`${toFetch.length} new stocks to fetch (of ${Object.keys(symbolMap).length} total in the 353 universe).`);

  let count = 0;
  for (const [symbol, instrumentKey] of toFetch) {
    try {
      const day = await fetchCandles(instrumentKey, 'day', RANGES.day.from, RANGES.day.to);
      const week = await fetchCandles(instrumentKey, 'week', RANGES.week.from, RANGES.week.to);
      const month = await fetchCandles(instrumentKey, 'month', RANGES.month.from, RANGES.month.to);
      cache[symbol] = { day, week, month };
      count++;
      if (count % 20 === 0) {
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
        console.log(`  ...${count}/${toFetch.length} fetched, checkpointed.`);
      }
    } catch (e) {
      console.warn(`  FAILED ${symbol}: ${e.message}`);
    }
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  console.log(`Done. ${Object.keys(cache).length} symbols now cached (${count}/${toFetch.length} new fetches succeeded).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
