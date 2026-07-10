#!/usr/bin/env node
'use strict';

/**
 * Checks how a real, same-day signal actually played out, using TradingView
 * Desktop's live session data (see tradingviewCandles.js for why this exists
 * separately from the Upstox-based run.js/tune_time_exit.js).
 *
 * Usage:
 *   node backtest/same-day-check.js SYMBOL ENTRY_ISO [RATING]
 *   node backtest/same-day-check.js --csv signals.csv
 *     (signals.csv columns: symbol,entry_iso,rating — no instrument_key needed,
 *      TradingView is driven by symbol directly)
 *
 * Every checked signal is appended to backtest/same_day_checks.csv so repeated
 * real-world checks accumulate into a growing dataset over time, same spirit as
 * TradeLog.java on the live side.
 *
 * Strategy params (target/stop/trail/time-exit) mirror application.yml's upstox:
 * section — hand-kept in sync, same caveat as run.js and tune_time_exit.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { simulateTrade } = require('./simulate');
const { fetchTodayCandles } = require('./tradingviewCandles');

const PARAMS = { targetPct: 2.0, stopLossPct: 1.5, trailPct: 1.0, timeExitMinutes: 45 };
const LOG_PATH = path.join(__dirname, 'same_day_checks.csv');

function checkOne(symbol, entryIso, rating) {
  const entryTimeMs = new Date(entryIso).getTime();
  if (Number.isNaN(entryTimeMs)) {
    console.error(`Skipping ${symbol}: unparseable entry_iso "${entryIso}"`);
    return null;
  }

  let candles;
  try {
    candles = fetchTodayCandles(symbol);
  } catch (e) {
    console.error(`Skipping ${symbol}: ${e.message}`);
    return null;
  }

  const afterEntry = candles.filter((c) => c.timestampMs >= entryTimeMs);
  if (afterEntry.length === 0) {
    console.warn(
      `No candles at/after entry for ${symbol} @ ${entryIso} ` +
        `(outside TradingView's current session cache, or the entry hasn't happened yet)`
    );
    return null;
  }

  const entryPrice = afterEntry[0].open;
  const result = simulateTrade(entryPrice, entryTimeMs, afterEntry, PARAMS);
  const row = {
    symbol,
    rating: rating || '',
    entryIso,
    entryPrice,
    finalAction: result.final?.action || 'NONE',
    pnlPct: result.pnlPctOfCapital,
  };

  console.log(
    `${symbol.padEnd(12)} entry=${entryPrice.toFixed(2).padStart(9)}  ` +
      `final=${row.finalAction.padEnd(14)}  ` +
      `pnl=${row.pnlPct.toFixed(2).padStart(6)}%`
  );
  appendToLog(row);
  return row;
}

function appendToLog(row) {
  const header = 'checked_at,symbol,rating,entry_iso,entry_price,final_action,pnl_pct';
  const isNew = !fs.existsSync(LOG_PATH);
  const line = [
    new Date().toISOString(),
    row.symbol,
    row.rating,
    row.entryIso,
    row.entryPrice,
    row.finalAction,
    row.pnlPct.toFixed(4),
  ].join(',');
  fs.appendFileSync(LOG_PATH, (isNew ? header + '\n' : '') + line + '\n');
}

function parseCsv(text) {
  const [headerLine, ...lines] = text.trim().split('\n');
  const cols = headerLine.split(',').map((c) => c.trim());
  return lines.filter(Boolean).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    cols.forEach((c, i) => (row[c] = values[i] || ''));
    return row;
  });
}

function main() {
  const args = process.argv.slice(2);
  let rows = [];

  if (args[0] === '--csv') {
    const csvPath = args[1];
    if (!csvPath) {
      console.error('Usage: node backtest/same-day-check.js --csv signals.csv');
      process.exit(1);
    }
    rows = parseCsv(fs.readFileSync(csvPath, 'utf8')).map((r) => ({
      symbol: r.symbol,
      entryIso: r.entry_iso,
      rating: r.rating,
    }));
  } else if (args.length >= 2) {
    rows = [{ symbol: args[0], entryIso: args[1], rating: args[2] || '' }];
  } else {
    console.error('Usage: node backtest/same-day-check.js SYMBOL ENTRY_ISO [RATING]');
    console.error('   or: node backtest/same-day-check.js --csv signals.csv   (columns: symbol,entry_iso,rating)');
    process.exit(1);
  }

  const results = [];
  for (const row of rows) {
    const r = checkOne(row.symbol, row.entryIso, row.rating);
    if (r) results.push(r);
  }

  if (results.length === 0) {
    console.log('\nNo trades simulated.');
    return;
  }

  const wins = results.filter((r) => r.pnlPct > 0).length;
  const avgPnl = results.reduce((s, r) => s + r.pnlPct, 0) / results.length;
  console.log('\n─── Summary ───────────────────────────────');
  console.log(`Checked   : ${results.length}`);
  console.log(`Win rate  : ${((wins / results.length) * 100).toFixed(1)}%`);
  console.log(`Avg P&L   : ${avgPnl.toFixed(2)}%`);
  console.log(`\nLogged to ${LOG_PATH}`);
}

if (require.main === module) {
  main();
}
