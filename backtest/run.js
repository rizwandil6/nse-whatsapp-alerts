#!/usr/bin/env node
'use strict';

/**
 * Backtest runner — replays historical signals against real Upstox 1-minute
 * candles using the exact same rule engine as live trading (tradeRules.js,
 * hand-kept in sync with TradeRules.java).
 *
 * WHY THIS DOESN'T SHIP WITH RESULTS ALREADY COMPUTED:
 * Running this for real needs two things this environment did not have access to:
 *   1. UPSTOX_ACCESS_TOKEN — Upstox's historical-candle endpoint requires OAuth.
 *      This is a live-trading credential; it should be set as an env var on
 *      whatever machine runs this, never pasted into a chat/PR/log.
 *   2. A CSV of historical signals (symbol, entry timestamp, instrument_key).
 *      NSE's own historical-announcement API blocks non-browser/cloud requests
 *      (the same bot-protection this project's own README already documents for
 *      the live circulars fetch) — there was no way to pull that list from here.
 *      The realistic source for this file going forward is trades.csv, produced
 *      by TradeLog once shadow-mode (see UpstoxTradeService.java) has been running
 *      for a while: filter it to mode=shadow or mode=live, event=entry rows.
 *
 * Usage:
 *   UPSTOX_ACCESS_TOKEN=xxx node backtest/run.js signals.csv
 *
 * signals.csv columns (header required): symbol,instrument_key,entry_iso,rating
 *   entry_iso example: 2026-07-10T09:16:32+05:30
 *
 * Strategy params below MUST be kept in sync by hand with application.yml's
 * upstox: section — there is no shared config file between the Java app and
 * this script.
 */

const fs = require('node:fs');
const { simulateTrade } = require('./simulate');
const { fetchCandles, isoDate } = require('./upstoxCandles');

const PARAMS = {
  targetPct: 2.0,
  stopLossPct: 1.5,
  trailPct: 1.0,
  timeExitMinutes: 45,
};

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

async function main() {
  const csvPath = process.argv[2];
  const token = process.env.UPSTOX_ACCESS_TOKEN;

  if (!csvPath) {
    console.error('Usage: UPSTOX_ACCESS_TOKEN=xxx node backtest/run.js signals.csv');
    process.exit(1);
  }
  if (!token) {
    console.error('UPSTOX_ACCESS_TOKEN is not set. This script needs it to fetch historical candles.');
    console.error('Set it as an env var on your machine — do not paste a live access token into chat.');
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`Loaded ${rows.length} signal(s) from ${csvPath}`);

  const results = [];
  for (const row of rows) {
    const { symbol, instrument_key: instrumentKey, entry_iso: entryIso, rating } = row;
    if (!symbol || !instrumentKey || !entryIso) {
      console.warn(`Skipping row with missing symbol/instrument_key/entry_iso: ${JSON.stringify(row)}`);
      continue;
    }
    const entryTimeMs = new Date(entryIso).getTime();
    if (Number.isNaN(entryTimeMs)) {
      console.warn(`Skipping row with unparseable entry_iso: ${entryIso}`);
      continue;
    }

    try {
      const from = isoDate(new Date(entryTimeMs));
      const to = isoDate(new Date(entryTimeMs + PARAMS.timeExitMinutes * 60000 + 3600000));
      const candles = await fetchCandles(instrumentKey, from, to, token);
      const afterEntry = candles.filter((c) => c.timestampMs >= entryTimeMs);
      if (afterEntry.length === 0) {
        console.warn(`No candles at/after entry for ${symbol} @ ${entryIso} — skipping`);
        continue;
      }
      const entryPrice = afterEntry[0].open;
      const result = simulateTrade(entryPrice, entryTimeMs, afterEntry, PARAMS);
      results.push({ symbol, rating, entryIso, entryPrice, ...result });
      console.log(
        `${symbol.padEnd(12)} entry=${entryPrice.toFixed(2).padStart(9)}  ` +
          `final=${(result.final?.action || 'NONE').padEnd(14)}  ` +
          `pnl=${result.pnlPctOfCapital.toFixed(2).padStart(6)}%`
      );
    } catch (e) {
      console.warn(`Error simulating ${symbol}: ${e.message}`);
    }
  }

  if (results.length === 0) {
    console.log('\nNo trades simulated — nothing to summarize.');
    return;
  }

  const wins = results.filter((r) => r.pnlPctOfCapital > 0).length;
  const avgPnl = results.reduce((s, r) => s + r.pnlPctOfCapital, 0) / results.length;
  const worst = results.reduce((min, r) => Math.min(min, r.pnlPctOfCapital), Infinity);
  const best = results.reduce((max, r) => Math.max(max, r.pnlPctOfCapital), -Infinity);
  const byReason = {};
  for (const r of results) {
    const key = r.final?.action || 'NONE';
    byReason[key] = (byReason[key] || 0) + 1;
  }

  console.log('\n─── Summary ───────────────────────────────');
  console.log(`Trades simulated : ${results.length}`);
  console.log(`Win rate         : ${((wins / results.length) * 100).toFixed(1)}%`);
  console.log(`Avg P&L          : ${avgPnl.toFixed(2)}% of capital-per-trade`);
  console.log(`Best / worst     : ${best.toFixed(2)}% / ${worst.toFixed(2)}%`);
  console.log(`Exit reasons     : ${JSON.stringify(byReason)}`);

  const outPath = csvPath.replace(/\.csv$/, '') + '.results.csv';
  const outLines = ['symbol,rating,entry_iso,entry_price,final_action,pnl_pct'];
  for (const r of results) {
    outLines.push(
      [r.symbol, r.rating, r.entryIso, r.entryPrice, r.final?.action || 'NONE', r.pnlPctOfCapital.toFixed(4)].join(',')
    );
  }
  fs.writeFileSync(outPath, outLines.join('\n') + '\n');
  console.log(`\nPer-trade results written to ${outPath}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
