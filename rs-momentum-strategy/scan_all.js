'use strict';

/**
 * Main backtest entry point. Reuses swing-strategy's mtf_candle_cache.json
 * for stock Daily candles (355-stock halal universe) and this folder's own
 * nifty_daily_cache.json for the benchmark. Computes RS ranks for the
 * whole universe once (a genuinely cross-sectional computation, can't be
 * done per-stock in isolation), then finds entries/exits per stock.
 *
 * NOTE: Sales Growth (the fundamental confirmation from the source) is
 * NOT applied here — Screener.in only exposes current-moment ratios, no
 * historical point-in-time snapshots, so it can't be backtested without
 * lookahead bias (same limitation multibagger-screener already
 * documented). This backtests the RS-momentum technical rule alone. See
 * README for how Sales Growth would be applied at live-alert time instead.
 */

const fs = require('fs');
const path = require('path');
const { computeRsRawSeries, percentileRankByDate, buildDateIndexMap, isoDate } = require('./rs_rank');
const { findRsCrossingsAbove80 } = require('./signal_engine');
const { simulateRsMomentumTrades } = require('./simulate_rs');

const CACHE_PATH = path.join(__dirname, '..', 'swing-strategy', 'mtf_candle_cache.json');
const NIFTY_PATH = path.join(__dirname, 'nifty_daily_cache.json');
const OUT_PATH = path.join(__dirname, 'signals_found.json');

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const nifty = JSON.parse(fs.readFileSync(NIFTY_PATH, 'utf8'));
  const niftyDateMap = buildDateIndexMap(nifty);
  const symbols = Object.keys(cache);

  console.log(`Computing RS_raw for ${symbols.length} stocks...`);
  const rsRawBySymbolByDate = {};
  const dayBySymbol = {};
  for (const symbol of symbols) {
    const day = cache[symbol].day;
    if (!day || day.length < 300) continue;
    dayBySymbol[symbol] = day;
    const series = computeRsRawSeries(day, nifty, niftyDateMap);
    const byDate = {};
    for (let i = 0; i < day.length; i++) if (series[i] != null) byDate[isoDate(day[i].timestampMs)] = series[i];
    rsRawBySymbolByDate[symbol] = byDate;
  }

  console.log('Ranking cross-sectionally...');
  const ranked = percentileRankByDate(rsRawBySymbolByDate);

  console.log('Finding entries/exits...');
  const allTrades = [];
  for (const symbol of Object.keys(dayBySymbol)) {
    const day = dayBySymbol[symbol];
    const rankByDate = ranked[symbol];
    const crossings = findRsCrossingsAbove80(day, rankByDate);
    const trades = simulateRsMomentumTrades(day, rankByDate, crossings);
    for (const t of trades) allTrades.push({ symbol, ...t });
  }

  console.log(`\nTotal trades: ${allTrades.length}\n`);
  if (allTrades.length === 0) {
    console.log('No trades — nothing to summarize.');
    return;
  }

  const wins = allTrades.filter((t) => t.pnlPct > 0).length;
  const avgPnl = allTrades.reduce((s, t) => s + t.pnlPct, 0) / allTrades.length;
  const avgHold = allTrades.reduce((s, t) => s + t.holdDays, 0) / allTrades.length;
  const byReason = {};
  for (const t of allTrades) byReason[t.exitReason] = (byReason[t.exitReason] || 0) + 1;

  console.log('--- Overall ---');
  console.log(`Win rate: ${((wins / allTrades.length) * 100).toFixed(1)}%`);
  console.log(`Avg P&L per trade: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`);
  console.log(`Avg hold days: ${avgHold.toFixed(1)} (~${(avgHold / 21).toFixed(1)} months)`);
  console.log(`Exit reasons: ${JSON.stringify(byReason)}`);

  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  console.log(`Median P&L: ${median(allTrades.map((t) => t.pnlPct)).toFixed(2)}%`);

  const big = allTrades.filter((t) => t.pnlPct >= 100).length;
  console.log(`Trades with >=100% gain ("real multibaggers"): ${big}`);

  console.log('\n--- By exit reason ---');
  for (const reason of ['RS_WEAKNESS', 'MAX_HOLD_CAP', 'DATA_EXHAUSTED']) {
    const subset = allTrades.filter((t) => t.exitReason === reason);
    if (subset.length === 0) continue;
    const w = subset.filter((t) => t.pnlPct > 0).length;
    const a = subset.reduce((s, t) => s + t.pnlPct, 0) / subset.length;
    console.log(`  ${reason.padEnd(16)} n=${subset.length}  win=${((w / subset.length) * 100).toFixed(1)}%  avg=${a >= 0 ? '+' : ''}${a.toFixed(2)}%`);
  }

  console.log('\n--- Top 10 trades by P&L ---');
  const top10 = [...allTrades].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 10);
  for (const t of top10) {
    console.log(`  ${t.symbol.padEnd(14)} ${t.entryDate} -> ${t.exitDate} (${t.holdDays}d) ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}% [${t.exitReason}]`);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(allTrades, null, 1));
  console.log(`\nTrades written to ${OUT_PATH}`);
}

main();
