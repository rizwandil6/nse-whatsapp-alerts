'use strict';

/**
 * Fetches Daily/Weekly/Monthly candles for the 178-stock Nifty Microcap 250
 * halal-screened addition (see README's "Universe expanded to 530" section)
 * not yet present in mtf_candle_cache.json -- idempotent, safe to re-run,
 * skips symbols already cached. Same pattern as fetch_new_353_stocks.js, same
 * date ranges so the new symbols are directly comparable against the existing
 * cached history.
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, 'mtf_candle_cache.json');
const NEW_178_PATH = path.join(__dirname, 'symbols_178_microcap_new.json');

const TOKEN = (process.env.UPSTOX_ACCESS_TOKEN || '').trim();
const UPSTOX_BASE = 'https://api.upstox.com/v2';

const RANGES = {
  day: { from: '2021-07-10', to: '2026-07-09' },
  week: { from: '2021-07-10', to: '2026-07-09' },
  month: { from: '2016-07-10', to: '2026-07-09' },
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  if (!TOKEN) throw new Error('UPSTOX_ACCESS_TOKEN not set');
  let cache = {};
  if (fs.existsSync(CACHE_PATH)) cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));

  const microcapNew = JSON.parse(fs.readFileSync(NEW_178_PATH, 'utf8'));

  const toFetch = Object.entries(microcapNew).filter(([symbol]) => !cache[symbol]);
  console.log(`${toFetch.length} new microcap stocks to fetch (of ${Object.keys(microcapNew).length} total).`);

  let count = 0;
  for (const [symbol, instrumentKey] of toFetch) {
    try {
      const day = await fetchCandles(instrumentKey, 'day', RANGES.day.from, RANGES.day.to);
      await sleep(150);
      const week = await fetchCandles(instrumentKey, 'week', RANGES.week.from, RANGES.week.to);
      await sleep(150);
      const month = await fetchCandles(instrumentKey, 'month', RANGES.month.from, RANGES.month.to);
      await sleep(150);
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
