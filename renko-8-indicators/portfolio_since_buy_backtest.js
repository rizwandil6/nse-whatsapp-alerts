'use strict';
/**
 * DarvasBox backtest per portfolio holding, run from each symbol's OWN actual
 * buy date (not a uniform window) -- uses portfolio_since_buy_cache.json,
 * which has extra warm-up history before each buy date so box-confirmation
 * has real data to build from, then only counts trades whose ENTRY date is
 * on/after the real buy date (same convention as the RVNL overlay).
 */
const fs = require('fs');
const path = require('path');
const { buildRenkoBricks } = require('./renko');
const { stochastic, bollinger, donchian, dmi, awesomeOscillator, sma, applyOffset } = require('./indicators');
const { strategies } = require('./strategies');

const BRICK_PCT = parseFloat(process.env.BRICK_PCT || '0.3') / 100;

const HOLDINGS = {
  CONCOR: { qty: 23, avg: 542.17 },
  GAIL: { qty: 75, avg: 198.19 },
  HATHWAY: { qty: 58, avg: 15.23 },
  HINDCOPPER: { qty: 42, avg: 704.85 },
  JKIL: { qty: 25, avg: 707.85 },
  JSWINFRA: { qty: 66, avg: 318.35 },
  MANINDS: { qty: 71, avg: 591 },
  MHRIL: { qty: 52, avg: 367.95 },
  NHPC: { qty: 350, avg: 87.99 },
  OLAELEC: { qty: 3059, avg: 47.34 },
  ORIENTELEC: { qty: 226, avg: 185.80 },
  RAILTEL: { qty: 14, avg: 437.65 },
  RVNL: { qty: 961, avg: 383.30 },
  SUZLON: { qty: 615, avg: 59.65 },
  WAAREEENER: { qty: 56, avg: 3734 },
  ADSL: { qty: 52, avg: 233 },
  'ARE&M': { qty: 15, avg: 1075 },
  NCC: { qty: 61, avg: 247.80 },
  STERTOOLS: { qty: 28, avg: 539.10 },
  TEXRAIL: { qty: 76, avg: 199 },
  TITAGARH: { qty: 16, avg: 948.12 },
};
const PORTFOLIO = Object.keys(HOLDINGS);

const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'portfolio_since_buy_cache.json'), 'utf8'));

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
const summary = [];
const allTrades = [];

for (const symbol of PORTFOLIO) {
  const entry = cache[symbol];
  const h = HOLDINGS[symbol];
  const investmentRs = h.qty * h.avg;
  if (!entry) {
    console.warn(`NO DATA for ${symbol}`);
    summary.push({ symbol, qty: h.qty, avg: h.avg, buyDate: null, investmentRs, trades: 0, netRs: 0, currentPrice: null, note: 'no data' });
    continue;
  }
  const { fiveMin, buyDate } = entry;
  const bricks = buildRenkoBricks(fiveMin, BRICK_PCT);
  if (bricks.length < 100) {
    console.warn(`${symbol}: only ${bricks.length} bricks -- below warm-up minimum`);
    summary.push({ symbol, qty: h.qty, avg: h.avg, buyDate, investmentRs, trades: 0, netRs: 0, currentPrice: fiveMin.length ? fiveMin[fiveMin.length - 1].close : null, note: 'insufficient warm-up' });
    continue;
  }
  const ctx = buildIndicatorContext(bricks);
  const allSymbolTrades = runStrategyOnSymbol(symbol, ctx, darvas);
  // Only count trades whose entry is on/after the real buy date -- everything before that is warm-up only.
  const trades = allSymbolTrades.filter((t) => t.date >= buyDate);
  for (const t of trades) {
    const rs = realRupees(t.entry, t.exitPrice, t.direction, h.qty);
    t.qty = h.qty;
    t.grossRs = rs.grossRs;
    t.costRs = rs.costRs;
    t.netRs = rs.netRs;
  }
  const netRs = trades.reduce((s, t) => s + t.netRs, 0);
  const currentPrice = fiveMin[fiveMin.length - 1].close;
  const buyHoldRs = h.qty * (currentPrice - h.avg);
  allTrades.push(...trades);
  summary.push({
    symbol, qty: h.qty, avg: h.avg, buyDate, investmentRs,
    trades: trades.length, netRs, currentPrice, buyHoldRs,
    warmupBricks: bricks.length,
  });
  console.log(`${symbol}: buy ${buyDate}, ${bricks.length} bricks total, ${trades.length} trades since buy, net Rs${netRs.toFixed(0)}, buy&hold Rs${buyHoldRs.toFixed(0)}`);
}

allTrades.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
const brickLabel = (BRICK_PCT * 100).toString().replace('.', '_');
fs.writeFileSync(path.join(__dirname, `trades_since_buy_DarvasBox_${brickLabel}pct.json`), JSON.stringify(allTrades, null, 1));
fs.writeFileSync(path.join(__dirname, `summary_since_buy_DarvasBox_${brickLabel}pct.json`), JSON.stringify(summary, null, 1));

const totalInvestment = summary.reduce((s, r) => s + r.investmentRs, 0);
const totalNetRs = summary.reduce((s, r) => s + r.netRs, 0);
const totalBuyHold = summary.reduce((s, r) => s + (r.buyHoldRs || 0), 0);
console.log(`\n=== Since-buy-date DarvasBox @ ${BRICK_PCT * 100}% brick ===`);
console.log(`Total invested: Rs${totalInvestment.toFixed(0)}`);
console.log(`Total DarvasBox net (since each buy date): Rs${totalNetRs.toFixed(0)} (${((totalNetRs / totalInvestment) * 100).toFixed(2)}% of invested capital)`);
console.log(`Total buy & hold P&L (current price vs avg cost): Rs${totalBuyHold.toFixed(0)} (${((totalBuyHold / totalInvestment) * 100).toFixed(2)}%)`);
