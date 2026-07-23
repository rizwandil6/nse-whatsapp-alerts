'use strict';
/** DarvasBox backtest run against the user's actual 21-stock portfolio holdings (not the broader watchlist), both LONG and SHORT. Brick size configurable via BRICK_PCT env var. */

const fs = require('fs');
const path = require('path');
const { buildRenkoBricks } = require('./renko');
const { stochastic, bollinger, donchian, dmi, awesomeOscillator, sma, applyOffset } = require('./indicators');
const { strategies } = require('./strategies');

const BRICK_PCT = parseFloat(process.env.BRICK_PCT || '0.25') / 100;
const PORTFOLIO = ['CONCOR', 'GAIL', 'HATHWAY', 'HINDCOPPER', 'JKIL', 'JSWINFRA', 'MANINDS', 'MHRIL', 'NHPC', 'OLAELEC', 'ORIENTELEC', 'RAILTEL', 'RVNL', 'SUZLON', 'WAAREEENER', 'ADSL', 'ARE&M', 'NCC', 'STERTOOLS', 'TEXRAIL', 'TITAGARH'];

// Real held quantity per symbol -- every trade is sized at this many shares
// (not a flat notional), so grossRs/costRs/netRs below reflect what the
// strategy would actually have moved on your real position, same treatment
// as the RVNL Sell-High-Buy-Low overlay.
const QTY = {
  CONCOR: 23, GAIL: 75, HATHWAY: 58, HINDCOPPER: 42, JKIL: 25, JSWINFRA: 66,
  MANINDS: 71, MHRIL: 52, NHPC: 350, OLAELEC: 3059, ORIENTELEC: 226, RAILTEL: 14,
  RVNL: 961, SUZLON: 615, WAAREEENER: 56, ADSL: 52, 'ARE&M': 15, NCC: 61,
  STERTOOLS: 28, TEXRAIL: 76, TITAGARH: 16,
};

const mainCache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'renko-strategy', 'intraday_cache.json'), 'utf8'));
const watchlistCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist_cache.json'), 'utf8'));

function getFiveMin(symbol) {
  if (watchlistCache[symbol]) return watchlistCache[symbol].fiveMin;
  if (mainCache[symbol]) return mainCache[symbol].fiveMin;
  return null;
}

function buildIndicatorContext(bricks) {
  const stoch = stochastic(bricks, 5, 3, 3);
  const bbands = bollinger(bricks, 20, 2, 10);
  const donch = donchian(bricks, 52, 10);
  const dmi14 = dmi(bricks, 14);
  const dmi50 = dmi(bricks, 50);
  const ao = awesomeOscillator(bricks);
  const closes = bricks.map((b) => b.close);
  const sma50 = sma(closes, 50);
  const sma20 = sma(closes, 20);
  const sma10Offset = applyOffset(sma(closes, 10), 5);
  return { bricks, stoch, bbands, donch, dmi14, dmi50, ao, sma50, sma20, sma10Offset };
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
function istDateStr(ms) { return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10); }

function runStrategyOnSymbol(symbol, ctx, strategy) {
  const { bricks } = ctx;
  const trades = [];
  let position = null;
  for (let i = 1; i < bricks.length; i++) {
    const dayChanged = istDateStr(bricks[i].timestampMs) !== istDateStr(bricks[i - 1].timestampMs);
    if (position) {
      if (dayChanged) {
        trades.push(closeTrade(symbol, bricks, position, i - 1, 'EOD_SQUARE_OFF', bricks[i - 1].close));
        position = null;
      } else {
        const b = bricks[i];
        const stopHit = position.direction === 'LONG' ? (b.direction === 'down' && b.low <= position.stop) : (b.direction === 'up' && b.high >= position.stop);
        if (stopHit) {
          trades.push(closeTrade(symbol, bricks, position, i, 'STOP_LOSS', position.stop));
          position = null;
        } else {
          const exitReason = strategy.getExit(i, ctx, position);
          if (exitReason) {
            trades.push(closeTrade(symbol, bricks, position, i, exitReason, b.close));
            position = null;
          }
        }
      }
    }
    if (!position && !dayChanged) {
      const direction = strategy.getEntry(i, ctx);
      if (direction) {
        const stop = strategy.getStop(i, ctx, direction, i);
        if (stop != null) position = { direction, entry: bricks[i].close, entryIdx: i, stop };
      }
    }
  }
  if (position) trades.push(closeTrade(symbol, bricks, position, bricks.length - 1, 'EOD_SQUARE_OFF', bricks[bricks.length - 1].close));
  return trades;
}

function closeTrade(symbol, bricks, position, exitIdx, action, exitPrice) {
  const pnlPct = position.direction === 'LONG' ? ((exitPrice - position.entry) / position.entry) * 100 : ((position.entry - exitPrice) / position.entry) * 100;
  return { symbol, date: istDateStr(bricks[position.entryIdx].timestampMs), direction: position.direction, entry: position.entry, exitPrice, action, barsHeld: exitIdx - position.entryIdx, pnlPct };
}

const CAPITAL = 50000;
function costPct(entry, exit, direction) {
  const qty = CAPITAL / entry;
  const entryValue = qty * entry, exitValue = qty * exit;
  const buyValue = direction === 'LONG' ? entryValue : exitValue;
  const sellValue = direction === 'LONG' ? exitValue : entryValue;
  const brokerage = Math.min(20, buyValue * 0.0003) + Math.min(20, sellValue * 0.0003);
  const stt = sellValue * 0.00025;
  const exch = (buyValue + sellValue) * 0.0000297;
  const sebi = (buyValue + sellValue) * 0.000001;
  const stamp = buyValue * 0.00003;
  const gst = 0.18 * (brokerage + exch + sebi);
  return ((brokerage + stt + exch + sebi + stamp + gst) / CAPITAL) * 100;
}

/** Same cost model as costPct, but in real rupees at the symbol's actual held quantity -- not a flat notional. */
function realRupees(entry, exit, direction, qty) {
  const entryValue = qty * entry, exitValue = qty * exit;
  const buyValue = direction === 'LONG' ? entryValue : exitValue;
  const sellValue = direction === 'LONG' ? exitValue : entryValue;
  const brokerage = Math.min(20, buyValue * 0.0003) + Math.min(20, sellValue * 0.0003);
  const stt = sellValue * 0.00025;
  const exch = (buyValue + sellValue) * 0.0000297;
  const sebi = (buyValue + sellValue) * 0.000001;
  const stamp = buyValue * 0.00003;
  const gst = 0.18 * (brokerage + exch + sebi);
  const costRs = brokerage + stt + exch + sebi + stamp + gst;
  const grossRs = direction === 'LONG' ? (exitValue - entryValue) : (entryValue - exitValue);
  return { grossRs, costRs, netRs: grossRs - costRs };
}

const darvas = strategies.find((s) => s.name === 'DarvasBox');
const allTrades = [];
const perSymbol = {};

for (const symbol of PORTFOLIO) {
  const fiveMin = getFiveMin(symbol);
  if (!fiveMin) { console.warn(`NO DATA for ${symbol}`); continue; }
  const bricks = buildRenkoBricks(fiveMin, BRICK_PCT);
  if (bricks.length < 100) { console.warn(`${symbol}: only ${bricks.length} bricks -- below 100 warm-up minimum, skipped`); continue; }
  const ctx = buildIndicatorContext(bricks);
  const trades = runStrategyOnSymbol(symbol, ctx, darvas);
  const qty = QTY[symbol];
  for (const t of trades) {
    t.costPct = costPct(t.entry, t.exitPrice, t.direction);
    t.netPnlPct = t.pnlPct - t.costPct;
    const rs = realRupees(t.entry, t.exitPrice, t.direction, qty);
    t.qty = qty;
    t.grossRs = rs.grossRs;
    t.costRs = rs.costRs;
    t.netRs = rs.netRs;
  }
  allTrades.push(...trades);
  perSymbol[symbol] = trades;
  console.log(`${symbol}: ${bricks.length} bricks, ${trades.length} trades`);
}

allTrades.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
const brickLabel = (BRICK_PCT * 100).toString().replace('.', '_');
fs.writeFileSync(path.join(__dirname, `trades_portfolio_DarvasBox_${brickLabel}pct.json`), JSON.stringify(allTrades, null, 1));

console.log(`\n=== DarvasBox @ ${BRICK_PCT * 100}% brick, ${PORTFOLIO.length}-stock portfolio ===\n`);
const n = allTrades.length;
if (n === 0) { console.log('No trades.'); process.exit(0); }
const wins = allTrades.filter((t) => t.netPnlPct > 0).length;
const grossAvg = allTrades.reduce((s, t) => s + t.pnlPct, 0) / n;
const netAvg = allTrades.reduce((s, t) => s + t.netPnlPct, 0) / n;
const netSum = allTrades.reduce((s, t) => s + t.netPnlPct, 0);
const netSumRs = allTrades.reduce((s, t) => s + t.netRs, 0);
console.log(`Trades: ${n}  Net win rate: ${((wins / n) * 100).toFixed(1)}%  Gross avg: ${grossAvg >= 0 ? '+' : ''}${grossAvg.toFixed(3)}%  Net avg: ${netAvg >= 0 ? '+' : ''}${netAvg.toFixed(3)}%  Net sum: ${netSum >= 0 ? '+' : ''}${netSum.toFixed(2)}%  Net sum (real Rs, actual qty): ${netSumRs >= 0 ? '+' : ''}Rs${netSumRs.toFixed(0)}`);

const longs = allTrades.filter((t) => t.direction === 'LONG');
const shorts = allTrades.filter((t) => t.direction === 'SHORT');
for (const [label, arr] of [['LONG', longs], ['SHORT', shorts]]) {
  if (arr.length === 0) { console.log(`${label}: 0 trades`); continue; }
  const w = arr.filter((t) => t.netPnlPct > 0).length;
  const a = arr.reduce((s, t) => s + t.netPnlPct, 0) / arr.length;
  console.log(`${label}: n=${arr.length}  netWin%=${((w / arr.length) * 100).toFixed(1)}  netAvg=${(a >= 0 ? '+' : '') + a.toFixed(3)}%`);
}

console.log('\nPer symbol:');
for (const symbol of PORTFOLIO) {
  const trades = perSymbol[symbol];
  if (!trades) { console.log(`  ${symbol.padEnd(12)} -- no data/skipped`); continue; }
  if (trades.length === 0) { console.log(`  ${symbol.padEnd(12)} 0 trades`); continue; }
  const w = trades.filter((t) => t.netPnlPct > 0).length;
  const a = trades.reduce((s, t) => s + t.netPnlPct, 0) / trades.length;
  console.log(`  ${symbol.padEnd(12)} n=${String(trades.length).padStart(3)}  netWin%=${((w / trades.length) * 100).toFixed(1).padStart(5)}  netAvg=${(a >= 0 ? '+' : '') + a.toFixed(3)}%`);
}
