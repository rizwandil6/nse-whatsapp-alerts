'use strict';

const fs = require('fs');
const { precompute, checkSignal } = require('./confluence');

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
  const daily = await fetchCandles('NSE_EQ|INE467B01029', 'day', '2021-07-10', '2026-07-09');
  const weekly = await fetchCandles('NSE_EQ|INE467B01029', 'week', '2021-07-10', '2026-07-09');
  const monthly = await fetchCandles('NSE_EQ|INE467B01029', 'month', '2016-07-10', '2026-07-09');
  console.log(`TCS: ${daily.length} daily, ${weekly.length} weekly, ${monthly.length} monthly candles\n`);

  const dailyP = precompute(daily);
  const weeklyP = precompute(weekly);
  const monthlyP = precompute(monthly);

  let signalCount = 0;
  const checkTally = {};
  for (let i = 60; i < daily.length; i++) {
    const result = checkSignal(dailyP, weeklyP, monthlyP, i);
    for (const [k, v] of Object.entries(result.checks || {})) {
      if (typeof v === 'boolean') {
        checkTally[k] = checkTally[k] || { true: 0, false: 0 };
        checkTally[k][v ? 'true' : 'false']++;
      }
    }
    if (result.fires) {
      signalCount++;
      const d = new Date(daily[i].timestampMs).toISOString().slice(0, 10);
      console.log(`SIGNAL on ${d}: entry=${result.entryPrice.toFixed(2)} stop=${result.stopLoss.toFixed(2)} target=${result.target.toFixed(2)}`);
    }
  }

  console.log(`\nTotal signals fired for TCS over ${daily.length - 60} days: ${signalCount}`);
  console.log('\n--- Individual check pass rates (how often each sub-condition is true) ---');
  for (const [k, v] of Object.entries(checkTally)) {
    const total = v.true + v.false;
    console.log(`  ${k.padEnd(20)} true=${v.true} (${((v.true / total) * 100).toFixed(1)}%)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
