'use strict';

const fs = require('fs');
const path = require('path');
const { precompute, checkSignal } = require('./confluence');

const CACHE_PATH = path.join(__dirname, 'mtf_candle_cache.json');

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const rsiWhenZone = [];
  const rsiWhenNoZone = [];
  let zoneAndRsiOk = 0;
  let zoneCount = 0;
  let bbTriggerAndZone = 0;
  let bbTriggerCount = 0;
  let zoneAndBbTrigger = 0;

  for (const [symbol, tf] of Object.entries(cache)) {
    if (!tf.day || tf.day.length < 100) continue;
    const dailyP = precompute(tf.day);
    const weeklyP = precompute(tf.week);
    const monthlyP = precompute(tf.month);

    for (let i = 60; i < tf.day.length; i++) {
      const result = checkSignal(dailyP, weeklyP, monthlyP, i);
      if (result.checks?.insufficientHistory) continue;
      const dailyRsi = result.checks.rsiValues?.daily;

      if (result.checks.hasConfluentZone) {
        zoneCount++;
        if (dailyRsi != null) rsiWhenZone.push(dailyRsi);
        if (result.checks.rsiOk) zoneAndRsiOk++;
        if (result.checks.bbTrigger) zoneAndBbTrigger++;
      } else if (dailyRsi != null) {
        rsiWhenNoZone.push(dailyRsi);
      }
      if (result.checks.bbTrigger) {
        bbTriggerCount++;
        if (result.checks.hasConfluentZone) bbTriggerAndZone++;
      }
    }
  }

  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  console.log(`Avg daily RSI when hasConfluentZone=true: ${avg(rsiWhenZone).toFixed(1)}  (n=${rsiWhenZone.length})`);
  console.log(`Avg daily RSI when hasConfluentZone=false: ${avg(rsiWhenNoZone).toFixed(1)}  (n=${rsiWhenNoZone.length})`);
  console.log(`\nOf ${zoneCount} confluent-zone days, RSI-ok (all 3 TF in [55,70]) on: ${zoneAndRsiOk} (${((zoneAndRsiOk / zoneCount) * 100).toFixed(2)}%)`);
  console.log(`Of ${zoneCount} confluent-zone days, BB-trigger fired on: ${zoneAndBbTrigger} (${((zoneAndBbTrigger / zoneCount) * 100).toFixed(2)}%)`);
  console.log(`Of ${bbTriggerCount} BB-trigger days, hasConfluentZone true on: ${bbTriggerAndZone} (${((bbTriggerAndZone / bbTriggerCount) * 100).toFixed(2)}%)`);

  // RSI distribution when in a zone, bucketed
  const buckets = {};
  for (const v of rsiWhenZone) {
    const b = Math.floor(v / 10) * 10;
    buckets[b] = (buckets[b] || 0) + 1;
  }
  console.log('\nRSI distribution (daily) when price is in a confluent demand zone:');
  for (const k of Object.keys(buckets).sort((a, b) => a - b)) {
    console.log(`  ${k}-${+k + 9}: ${buckets[k]} (${((buckets[k] / rsiWhenZone.length) * 100).toFixed(1)}%)`);
  }
}

main();
