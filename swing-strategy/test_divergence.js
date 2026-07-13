'use strict';

const fs = require('fs');
const { rsi } = require('./indicators');
const { detectSwingHighs, hasBearishDivergence } = require('./divergence');

const TOKEN = fs
  .readFileSync('/private/tmp/claude-501/-Users-adilrizwan-Downloads/fef5c952-3a52-453b-aac2-05d44213f064/scratchpad/.secrets/upstox_token.txt', 'utf8')
  .trim();

async function fetchCandles(instrumentKey, interval, from, to) {
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/${interval}/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await res.json();
  const raw = body?.data?.candles || [];
  return raw
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

async function main() {
  const weekly = await fetchCandles('NSE_EQ|INE467B01029', 'week', '2022-01-01', '2026-07-09'); // TCS, ~4.5yr weekly
  console.log(`Fetched ${weekly.length} weekly candles for TCS\n`);

  const rsi14 = rsi(weekly, 14);
  const asOf = weekly.length - 1;
  const swings = detectSwingHighs(weekly, asOf, 2);
  console.log(`Swing highs detected: ${swings.length} (out of ${weekly.length} weekly bars)\n`);

  console.log('--- Last 6 swing highs: date, price high, RSI ---');
  for (const idx of swings.slice(-6)) {
    const d = new Date(weekly[idx].timestampMs).toISOString().slice(0, 10);
    console.log(`  ${d}  high=${weekly[idx].high.toFixed(2)}  rsi=${rsi14[idx]?.toFixed(1) ?? 'null'}`);
  }

  const div = hasBearishDivergence(weekly, rsi14, asOf, { window: 2, lookbackPairs: 3 });
  console.log('\nBearish divergence check as of last bar:', JSON.stringify(div, null, 1));

  // scan history: how often does divergence get flagged (sanity on frequency, not too rare/too common)
  let classicCount = 0;
  let hiddenCount = 0;
  let checked = 0;
  for (let i = 60; i < weekly.length; i++) {
    const d = hasBearishDivergence(weekly, rsi14, i, { window: 2, lookbackPairs: 3 });
    checked++;
    if (d.type === 'classic') classicCount++;
    if (d.type === 'hidden') hiddenCount++;
  }
  console.log(`\nAcross ${checked} weekly bars scanned: classic bearish flagged on ${classicCount} bars, hidden bearish on ${hiddenCount} bars`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
