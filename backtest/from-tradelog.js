#!/usr/bin/env node
'use strict';

/**
 * Converts TradeLog's trades.csv (see TradeLog.java) into the signals.csv format
 * backtest/run.js expects: symbol,instrument_key,entry_iso,rating
 *
 * Usage: node backtest/from-tradelog.js trades.csv [--mode=shadow|live|all] > signals.csv
 */

const fs = require('node:fs');

const path = process.argv[2];
const modeArg = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=all').split('=')[1];

if (!path) {
  console.error('Usage: node backtest/from-tradelog.js trades.csv [--mode=shadow|live|all] > signals.csv');
  process.exit(1);
}

const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
const header = lines[0].split(',');
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

const out = ['symbol,instrument_key,entry_iso,rating'];
for (const line of lines.slice(1)) {
  const cols = line.split(',');
  if (cols[idx.event] !== 'entry') continue;
  if (modeArg !== 'all' && cols[idx.mode] !== modeArg) continue;
  const symbol = cols[idx.symbol];
  const instrumentKey = cols[idx.instrument_key];
  const entryIso = cols[idx.timestamp];
  const rating = cols[idx.rating];
  if (!symbol || !instrumentKey || !entryIso) continue;
  out.push(`${symbol},${instrumentKey},${entryIso},${rating}`);
}

process.stdout.write(out.join('\n') + '\n');
