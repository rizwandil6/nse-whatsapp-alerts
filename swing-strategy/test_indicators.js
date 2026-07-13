'use strict';

const fs = require('fs');
const { sma, ema, rsi, bollingerBands, isSmaRising, isGoldenCross } = require('./indicators');

const TOKEN = fs
  .readFileSync('/private/tmp/claude-501/-Users-adilrizwan-Downloads/fef5c952-3a52-453b-aac2-05d44213f064/scratchpad/.secrets/upstox_token.txt', 'utf8')
  .trim();

async function fetchDaily(instrumentKey, from, to) {
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/day/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await res.json();
  const raw = body?.data?.candles || [];
  return raw
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

async function main() {
  const candles = await fetchDaily('NSE_EQ|INE467B01029', '2025-01-01', '2026-07-09'); // TCS, ~1.5yr daily
  console.log(`Fetched ${candles.length} daily candles for TCS\n`);

  const sma50 = sma(candles, 50);
  const ema20 = ema(candles, 20);
  const ema50 = ema(candles, 50);
  const ema9 = ema(candles, 9);
  const sma20 = sma(candles, 20);
  const rsi14 = rsi(candles, 14);
  const bb = bollingerBands(candles, 20, 2);

  // sanity: print last 5 rows with all indicators
  console.log('date'.padEnd(12) + 'close'.padEnd(10) + 'sma50'.padEnd(10) + 'ema20'.padEnd(10) + 'ema50'.padEnd(10) + 'rsi14'.padEnd(8) + 'bbMid'.padEnd(10));
  for (let i = candles.length - 5; i < candles.length; i++) {
    const d = new Date(candles[i].timestampMs).toISOString().slice(0, 10);
    console.log(
      d.padEnd(12) +
        candles[i].close.toFixed(2).padEnd(10) +
        (sma50[i]?.toFixed(2) ?? 'null').padEnd(10) +
        (ema20[i]?.toFixed(2) ?? 'null').padEnd(10) +
        (ema50[i]?.toFixed(2) ?? 'null').padEnd(10) +
        (rsi14[i]?.toFixed(1) ?? 'null').padEnd(8) +
        (bb.middle[i]?.toFixed(2) ?? 'null').padEnd(10)
    );
  }

  // sanity checks
  console.log('\n--- Sanity checks ---');
  console.log('RSI stays in [0,100]:', rsi14.every((v) => v == null || (v >= 0 && v <= 100)));
  console.log('bbMid === sma20 everywhere (both are 20-period SMA of close):', bb.middle.every((v, i) => v === sma20[i]));
  console.log(
    'EMA converges near SMA on flat-ish data (last value diff ema20 vs sma20):',
    (ema20[ema20.length - 1] - sma20[sma20.length - 1]).toFixed(2)
  );

  let goldenCrosses = 0;
  for (let i = 0; i < candles.length; i++) if (isGoldenCross(ema20, ema50, i)) goldenCrosses++;
  console.log(`Golden crosses (20/50 EMA) detected over ${candles.length} days:`, goldenCrosses);

  let risingDays = 0;
  for (let i = 0; i < candles.length; i++) if (isSmaRising(sma50, i, 10)) risingDays++;
  console.log(`Days with 50-SMA "rising" (>= value 10 bars back):`, risingDays, `/`, candles.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
