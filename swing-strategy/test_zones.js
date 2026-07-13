'use strict';

const fs = require('fs');
const { findRawZones, scoreZone, activeQualifyingZones } = require('./zones');

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
  const candles = await fetchDaily('NSE_EQ|INE467B01029', '2024-01-01', '2026-07-09'); // TCS, ~2.5yr daily
  console.log(`Fetched ${candles.length} daily candles for TCS\n`);

  const asOf = candles.length - 1;
  const rawZones = findRawZones(candles, asOf);
  const demandZones = rawZones.filter((z) => z.type === 'DEMAND');
  const supplyZones = rawZones.filter((z) => z.type === 'SUPPLY');
  console.log(`Raw zones found: ${demandZones.length} demand, ${supplyZones.length} supply (out of ${candles.length} candles)\n`);

  console.log('--- Sample of 5 demand zones with scores ---');
  for (const zone of demandZones.slice(0, 5)) {
    const score = scoreZone(zone, candles, asOf);
    const d = new Date(candles[zone.formationIdx].timestampMs).toISOString().slice(0, 10);
    console.log(
      `formed=${d} baseCount=${zone.baseCount} proximal=${zone.proximal.toFixed(2)} distal=${zone.distal.toFixed(2)} ` +
        `score(fresh=${score.freshness},str=${score.strength},base=${score.timeAtBase})=${score.total}/7`
    );
  }

  console.log('\n--- Score distribution across all demand zones ---');
  const scoreDist = {};
  for (const zone of demandZones) {
    const s = scoreZone(zone, candles, asOf).total;
    scoreDist[s] = (scoreDist[s] || 0) + 1;
  }
  console.log(scoreDist);

  console.log('\n--- Active qualifying zones AS OF TODAY (last candle) ---');
  const activeDemand = activeQualifyingZones(candles, asOf, 'DEMAND');
  const activeSupply = activeQualifyingZones(candles, asOf, 'SUPPLY');
  console.log(`Active qualifying demand zones (price inside, score>=5): ${activeDemand.length}`);
  console.log(`Active qualifying supply zones (price inside, score>=5): ${activeSupply.length}`);
  for (const z of activeDemand) {
    const d = new Date(candles[z.formationIdx].timestampMs).toISOString().slice(0, 10);
    console.log(`  DEMAND formed=${d} proximal=${z.proximal.toFixed(2)} distal=${z.distal.toFixed(2)} score=${z.score.total}`);
  }

  // Scan how many times across full history price entered a qualifying demand zone (i.e. potential signal days)
  console.log('\n--- Scanning full history for "price enters a qualifying demand zone" events (expensive, may take a moment) ---');
  let signalDays = 0;
  for (let i = 100; i < candles.length; i++) {
    const active = activeQualifyingZones(candles, i, 'DEMAND');
    if (active.length > 0) signalDays++;
  }
  console.log(`Days (out of ${candles.length - 100} scanned) where price sat inside a qualifying demand zone: ${signalDays}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
