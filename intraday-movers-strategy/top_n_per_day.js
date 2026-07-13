'use strict';

/**
 * Filters trades_orb.json down to the top N per day, ranked by breakout
 * volume ratio (breakout-bar volume / average opening-range volume) — the
 * same signal already shown to correlate with quality (higher volume
 * confirmation multiplier -> better win rate), just applied as a per-day
 * ranking instead of a fixed universal threshold.
 */

const fs = require('fs');
const path = require('path');

const N = parseInt(process.env.TOP_N || '10', 10);
const trades = JSON.parse(fs.readFileSync(path.join(__dirname, 'trades_orb.json'), 'utf8'));

const byDate = new Map();
for (const t of trades) {
  if (!byDate.has(t.date)) byDate.set(t.date, []);
  byDate.get(t.date).push(t);
}

const filtered = [];
for (const dayTrades of byDate.values()) {
  dayTrades.sort((a, b) => b.breakoutVolumeRatio - a.breakoutVolumeRatio);
  filtered.push(...dayTrades.slice(0, N));
}

function summarize(list, label) {
  if (!list.length) { console.log(label + ': no trades'); return; }
  const wins = list.filter((t) => t.netPnlPct > 0).length;
  const grossAvg = list.reduce((s, t) => s + t.pnlPct, 0) / list.length;
  const netAvg = list.reduce((s, t) => s + t.netPnlPct, 0) / list.length;
  console.log(`${label}: n=${list.length}  netWin=${((wins / list.length) * 100).toFixed(1)}%  grossAvg=${grossAvg >= 0 ? '+' : ''}${grossAvg.toFixed(3)}%  netAvg=${netAvg >= 0 ? '+' : ''}${netAvg.toFixed(3)}%`);
}

// Apply the same cost model as apply_costs.js
const CAPITAL = 50000;
const BROKERAGE_RATE = 0.0003, BROKERAGE_CAP = 20, STT_RATE = 0.00025, EXCHANGE_TXN_RATE = 0.0000297, SEBI_RATE = 0.000001, STAMP_DUTY_RATE = 0.00003, GST_RATE = 0.18;
function costPct(entry, exit, direction) {
  const qty = CAPITAL / entry;
  const entryValue = qty * entry, exitValue = qty * exit;
  const buyValue = direction === 'LONG' ? entryValue : exitValue;
  const sellValue = direction === 'LONG' ? exitValue : entryValue;
  const brokerage = Math.min(BROKERAGE_CAP, buyValue * BROKERAGE_RATE) + Math.min(BROKERAGE_CAP, sellValue * BROKERAGE_RATE);
  const stt = sellValue * STT_RATE;
  const exch = (buyValue + sellValue) * EXCHANGE_TXN_RATE;
  const sebi = (buyValue + sellValue) * SEBI_RATE;
  const stamp = buyValue * STAMP_DUTY_RATE;
  const gst = GST_RATE * (brokerage + exch + sebi);
  return ((brokerage + stt + exch + sebi + stamp + gst) / CAPITAL) * 100;
}
for (const t of trades) { t.costPct = costPct(t.entry, t.exitPrice, t.direction); t.netPnlPct = t.pnlPct - t.costPct; }

console.log(`Top ${N} per day, ranked by breakout volume ratio:\n`);
summarize(trades, 'UNFILTERED (all qualifying trades)');
summarize(filtered, `TOP ${N}/DAY`);
console.log(`\nDays with trades: ${byDate.size}`);
console.log(`Avg trades/day before filter: ${(trades.length / byDate.size).toFixed(1)}`);
console.log(`Avg trades/day after filter: ${(filtered.length / byDate.size).toFixed(1)}`);
