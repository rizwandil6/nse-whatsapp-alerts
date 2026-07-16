'use strict';

/**
 * Fetches NSE_INDEX|Nifty 50 Daily candles, matching swing-strategy's
 * mtf_candle_cache.json stock date range (2021-07-11 onward), needed as
 * the benchmark for relative-strength calculations.
 */

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '..', '.secrets', 'upstox_token.txt');
const TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const OUT_PATH = path.join(__dirname, 'nifty_daily_cache.json');

async function fetchDaily(instrumentKey, from, to) {
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/day/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const raw = body?.data?.candles || [];
  return raw
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

async function main() {
  console.log('Fetching Nifty 50 daily candles...');
  const candles = await fetchDaily('NSE_INDEX|Nifty 50', '2021-07-01', '2026-07-15');
  console.log(`-> ${candles.length} daily candles`);
  console.log('first:', new Date(candles[0].timestampMs).toISOString().slice(0, 10));
  console.log('last:', new Date(candles[candles.length - 1].timestampMs).toISOString().slice(0, 10));
  fs.writeFileSync(OUT_PATH, JSON.stringify(candles));
  console.log('Written to', OUT_PATH);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
