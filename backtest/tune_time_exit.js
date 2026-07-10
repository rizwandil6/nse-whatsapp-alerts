#!/usr/bin/env node
'use strict';

/**
 * Fetches candles ONCE per signal (cached to disk), then replays the simulator
 * against the same cached data with different timeExitMinutes values. Avoids
 * re-hitting Upstox's historical-candle API once per parameter variant.
 *
 * Usage: UPSTOX_ACCESS_TOKEN=xxx node backtest/tune_time_exit.js signals.csv
 */

const fs = require('node:fs');
const { simulateTrade } = require('./simulate');
const { fetchCandles, isoDate } = require('./upstoxCandles');

const BASE_PARAMS = { targetPct: 2.0, stopLossPct: 1.5, trailPct: 1.0 };
// Candidate time-exit windows to compare, in minutes. 375 = full trading day
// (09:15-15:30) — beyond that isn't meaningful for an MIS/intraday product,
// which brokers auto-square-off same day regardless.
const CANDIDATE_MINUTES = [15, 30, 45, 60, 90, 120, 180, 375];

function parseCsv(text) {
  const [headerLine, ...lines] = text.trim().split('\n');
  const cols = headerLine.split(',').map((c) => c.trim());
  return lines.filter(Boolean).map((line) => {
    const values = line.split(',');
    const row = {};
    cols.forEach((c, i) => (row[c] = (values[i] || '').trim()));
    return row;
  });
}

async function loadOrFetchCandles(signals, token, cachePath) {
  let cache = {};
  if (fs.existsSync(cachePath)) {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    console.log(`Loaded ${Object.keys(cache).length} cached candle set(s) from ${cachePath}`);
  }

  let fetched = 0;
  for (const row of signals) {
    const { symbol, instrument_key: instrumentKey, entry_iso: entryIso } = row;
    const cacheKey = `${instrumentKey}@${entryIso}`;
    if (cache[cacheKey]) continue;

    const entryTimeMs = new Date(entryIso).getTime();
    if (Number.isNaN(entryTimeMs)) continue;

    try {
      const from = isoDate(new Date(entryTimeMs));
      const to = isoDate(new Date(entryTimeMs + 8 * 3600000)); // full trading day buffer
      const candles = await fetchCandles(instrumentKey, from, to, token);
      const afterEntry = candles.filter((c) => c.timestampMs >= entryTimeMs);
      cache[cacheKey] = afterEntry;
      fetched++;
      if (fetched % 15 === 0) {
        console.log(`  fetched ${fetched} new candle set(s)...`);
        fs.writeFileSync(cachePath, JSON.stringify(cache));
      }
    } catch (e) {
      console.warn(`Fetch failed for ${symbol}: ${e.message}`);
      cache[cacheKey] = [];
    }
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  console.log(`Candle cache written to ${cachePath} (${Object.keys(cache).length} total entries)`);
  return cache;
}

function summarize(results) {
  if (results.length === 0) return null;
  const wins = results.filter((r) => r.pnlPctOfCapital > 0).length;
  const avgPnl = results.reduce((s, r) => s + r.pnlPctOfCapital, 0) / results.length;
  const byReason = {};
  for (const r of results) {
    const key = r.final?.action || 'NONE';
    byReason[key] = (byReason[key] || 0) + 1;
  }
  return {
    n: results.length,
    winRate: (wins / results.length) * 100,
    avgPnl,
    byReason,
  };
}

async function main() {
  const csvPath = process.argv[2];
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!csvPath || !token) {
    console.error('Usage: UPSTOX_ACCESS_TOKEN=xxx node backtest/tune_time_exit.js signals.csv');
    process.exit(1);
  }

  const signals = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`Loaded ${signals.length} signal(s) from ${csvPath}`);

  const cachePath = csvPath.replace(/\.csv$/, '') + '.candle_cache.json';
  const cache = await loadOrFetchCandles(signals, token, cachePath);

  console.log('\n─── Time-exit window comparison (target=2.0%, stop=1.5%, trail=1.0%, unchanged) ───\n');
  console.log('minutes'.padEnd(9) + 'n'.padEnd(5) + 'win_rate'.padEnd(11) + 'avg_pnl'.padEnd(10) + 'exit_reasons');

  for (const minutes of CANDIDATE_MINUTES) {
    const params = { ...BASE_PARAMS, timeExitMinutes: minutes };
    const results = [];
    for (const row of signals) {
      const { symbol, instrument_key: instrumentKey, entry_iso: entryIso, rating } = row;
      const cacheKey = `${instrumentKey}@${entryIso}`;
      const candles = cache[cacheKey];
      if (!candles || candles.length === 0) continue;
      const entryTimeMs = new Date(entryIso).getTime();
      const entryPrice = candles[0].open;
      const result = simulateTrade(entryPrice, entryTimeMs, candles, params);
      results.push({ symbol, rating, entryIso, entryPrice, ...result });
    }
    const s = summarize(results);
    if (!s) {
      console.log(`${String(minutes).padEnd(9)}0`);
      continue;
    }
    console.log(
      `${String(minutes).padEnd(9)}${String(s.n).padEnd(5)}${s.winRate.toFixed(1).padStart(6)}%    ${s.avgPnl
        .toFixed(2)
        .padStart(6)}%    ${JSON.stringify(s.byReason)}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
