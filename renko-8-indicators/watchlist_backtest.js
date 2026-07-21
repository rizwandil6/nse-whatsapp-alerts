'use strict';
/** DarvasBox @ 1.5% brick size, run against the user's pasted 23-stock watchlist specifically. */

const fs = require('fs');
const path = require('path');
const { buildRenkoBricks } = require('./renko');
const { stochastic, bollinger, donchian, dmi, awesomeOscillator, sma, applyOffset } = require('./indicators');
const { strategies } = require('./strategies');

const BRICK_PCT = parseFloat(process.env.BRICK_PCT || '1.5') / 100;
const WATCHLIST = ['CONCOR', 'HATHWAY', 'NHPC', 'JSWINFRA', 'JKIL', 'SUZLON', 'WAAREEENER', 'OLAELEC', 'HINDCOPPER', 'MHRIL', 'RVNL', 'RAILTEL', 'GAIL', 'ADSL', 'ARE&M', 'NCC', 'STERTOOLS', 'TEXRAIL', 'TITAGARH', 'MANINDS', 'SERVOTECH', 'IRCON', 'TRITURBINE'];

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

const darvas = strategies.find((s) => s.name === 'DarvasBox');
const allTrades = [];
const perSymbol = {};

for (const symbol of WATCHLIST) {
  const fiveMin = getFiveMin(symbol);
  if (!fiveMin) { console.warn(`NO DATA for ${symbol}`); continue; }
  const bricks = buildRenkoBricks(fiveMin, BRICK_PCT);
  if (bricks.length < 100) { console.warn(`${symbol}: only ${bricks.length} bricks -- below 100 warm-up minimum, skipped`); continue; }
  const ctx = buildIndicatorContext(bricks);
  const trades = runStrategyOnSymbol(symbol, ctx, darvas);
  for (const t of trades) {
    t.costPct = costPct(t.entry, t.exitPrice, t.direction);
    t.netPnlPct = t.pnlPct - t.costPct;
  }
  allTrades.push(...trades);
  perSymbol[symbol] = trades;
  console.log(`${symbol}: ${bricks.length} bricks, ${trades.length} trades`);
}

allTrades.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
const brickLabel = (BRICK_PCT * 100).toString().replace('.', '_');
fs.writeFileSync(path.join(__dirname, `trades_watchlist_DarvasBox_${brickLabel}pct.json`), JSON.stringify(allTrades, null, 1));

console.log(`\n=== DarvasBox @ ${BRICK_PCT * 100}% brick, ${WATCHLIST.length}-stock watchlist ===\n`);
const n = allTrades.length;
if (n === 0) { console.log('No trades.'); process.exit(0); }
const wins = allTrades.filter((t) => t.netPnlPct > 0).length;
const grossAvg = allTrades.reduce((s, t) => s + t.pnlPct, 0) / n;
const netAvg = allTrades.reduce((s, t) => s + t.netPnlPct, 0) / n;
const netSum = allTrades.reduce((s, t) => s + t.netPnlPct, 0);
console.log(`Trades: ${n}  Net win rate: ${((wins / n) * 100).toFixed(1)}%  Gross avg: ${grossAvg >= 0 ? '+' : ''}${grossAvg.toFixed(3)}%  Net avg: ${netAvg >= 0 ? '+' : ''}${netAvg.toFixed(3)}%  Net sum: ${netSum >= 0 ? '+' : ''}${netSum.toFixed(2)}%`);

console.log('\nPer symbol:');
for (const symbol of WATCHLIST) {
  const trades = perSymbol[symbol];
  if (!trades) { console.log(`  ${symbol.padEnd(12)} -- no data/skipped`); continue; }
  if (trades.length === 0) { console.log(`  ${symbol.padEnd(12)} 0 trades`); continue; }
  const w = trades.filter((t) => t.netPnlPct > 0).length;
  const a = trades.reduce((s, t) => s + t.netPnlPct, 0) / trades.length;
  console.log(`  ${symbol.padEnd(12)} n=${String(trades.length).padStart(3)}  netWin%=${((w / trades.length) * 100).toFixed(1).padStart(5)}  netAvg=${(a >= 0 ? '+' : '') + a.toFixed(3)}%`);
}
