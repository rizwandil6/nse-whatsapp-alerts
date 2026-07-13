'use strict';

const fs = require('fs');
const path = require('path');
const { precompute, checkSignal } = require('./confluence');

const CACHE_PATH = path.join(__dirname, 'mtf_candle_cache.json');
const SECTOR_MAP_PATH = path.join(__dirname, 'sector_map.json');
const SECTOR_CACHE_PATH = path.join(__dirname, 'sector_candle_cache.json');

const GATING = ['trendRising', 'hasConfluentZone', 'rsiOk', 'noDivergence', 'bbTrigger', 'sectorStrong'];

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const sectorMap = JSON.parse(fs.readFileSync(SECTOR_MAP_PATH, 'utf8'));
  const sectorCandles = JSON.parse(fs.readFileSync(SECTOR_CACHE_PATH, 'utf8'));
  const sectorPrecomputed = {};
  for (const [name, candles] of Object.entries(sectorCandles)) sectorPrecomputed[name] = precompute(candles);

  // near-miss tally: count of days where exactly ONE gating condition is false, keyed by which one
  const soleBlocker = {};
  for (const k of GATING) soleBlocker[k] = 0;
  let fiveOfSixDays = 0;
  let allSixDays = 0;

  for (const [symbol, tf] of Object.entries(cache)) {
    if (!tf.day || tf.day.length < 100) continue;
    const dailyP = precompute(tf.day);
    const weeklyP = precompute(tf.week);
    const monthlyP = precompute(tf.month);
    const sectorName = sectorMap[symbol];
    const sectorMonthly = sectorName ? sectorPrecomputed[sectorName] : null;

    for (let i = 60; i < tf.day.length; i++) {
      const result = checkSignal(dailyP, weeklyP, monthlyP, i, sectorMonthly);
      if (result.checks?.insufficientHistory) continue;

      const falseOnes = GATING.filter((k) => !result.checks[k]);
      if (falseOnes.length === 0) allSixDays++;
      if (falseOnes.length === 1) {
        fiveOfSixDays++;
        soleBlocker[falseOnes[0]]++;
      }
    }
  }

  console.log(`Days where ALL 6 gating conditions passed (= signal fired): ${allSixDays}`);
  console.log(`Days where exactly 5 of 6 passed (one condition away from firing): ${fiveOfSixDays}\n`);
  console.log('Of those "one away" days, which single condition was the blocker:');
  const sorted = Object.entries(soleBlocker).sort((a, b) => b[1] - a[1]);
  for (const [k, count] of sorted) {
    console.log(`  ${k.padEnd(20)} blocked ${count} near-miss days (${((count / fiveOfSixDays) * 100).toFixed(1)}% of near-misses)`);
  }
}

main();
