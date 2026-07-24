'use strict';
/**
 * "Sell high, buy low" overlay on an EXISTING physical RVNL holding (961
 * shares @ Rs 271.60 avg, position taken 2025-08-01). Uses the confirmed-box
 * DarvasBox strategy's SHORT signals only -- a SHORT entry means: sell all
 * 961 shares from the holding at that price; the matching exit means: buy
 * back 961 shares to restore the holding. LONG signals are ignored entirely
 * (this isn't about opening new positions, only monetizing swings on shares
 * already owned). Brick context is built from the FULL 3-year history so
 * the box-confirmation state machine has real warm-up, but only trades with
 * entry date >= 2025-08-01 are counted in the realized P&L (the date the
 * user says they actually held the position from).
 */

const fs = require('fs');
const path = require('path');
const { buildRenkoBricks } = require('./renko');
const { stochastic, bollinger, donchian, dmi, awesomeOscillator, sma, applyOffset } = require('./indicators');
const { strategies } = require('./strategies');

const SYMBOL = 'RVNL';
const QTY = 961; // exact holding size -- fixed per trade, not capital-scaled
const AVG_BUY = 271.60;
const POSITION_START = '2025-08-01';

const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist_3y_cache.json'), 'utf8'));
const fiveMin = cache[SYMBOL].fiveMin;

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

// Same intraday round-trip cost model used throughout this project (Zerodha
// MIS: brokerage min Rs20/0.03%, STT, exchange/SEBI fees, stamp duty, GST).
// Selling shares already in demat and buying them back same day settles as
// an intraday round trip, not a fresh delivery buy -- same cost shape as
// every other short trade in this backtest suite, just on a fixed qty
// instead of a fixed capital.
function costRupees(entryPrice, exitPrice, qty) {
  const sellValue = qty * entryPrice; // sell first (short)
  const buyValue = qty * exitPrice;   // buy back to cover
  const brokerage = Math.min(20, buyValue * 0.0003) + Math.min(20, sellValue * 0.0003);
  const stt = sellValue * 0.00025;
  const exch = (buyValue + sellValue) * 0.0000297;
  const sebi = (buyValue + sellValue) * 0.000001;
  const stamp = buyValue * 0.00003;
  const gst = 0.18 * (brokerage + exch + sebi);
  return brokerage + stt + exch + sebi + stamp + gst;
}

function runShortOnly(ctx, strategy) {
  const { bricks } = ctx;
  const trades = [];
  let position = null;
  for (let i = 1; i < bricks.length; i++) {
    const dayChanged = istDateStr(bricks[i].timestampMs) !== istDateStr(bricks[i - 1].timestampMs);
    if (position) {
      if (dayChanged) {
        trades.push(closeTrade(bricks, position, i - 1, 'EOD_SQUARE_OFF', bricks[i - 1].close));
        position = null;
      } else {
        const b = bricks[i];
        const stopHit = b.direction === 'up' && b.high >= position.stop; // SHORT-only stop check
        if (stopHit) {
          trades.push(closeTrade(bricks, position, i, 'STOP_LOSS', position.stop));
          position = null;
        } else {
          const exitReason = strategy.getExit(i, ctx, position);
          if (exitReason) {
            trades.push(closeTrade(bricks, position, i, exitReason, b.close));
            position = null;
          }
        }
      }
    }
    if (!position && !dayChanged) {
      const direction = strategy.getEntry(i, ctx);
      if (direction === 'SHORT') { // LONG signals ignored -- not opening new positions, only selling held shares
        const stop = strategy.getStop(i, ctx, 'SHORT', i);
        if (stop != null) position = { direction: 'SHORT', entry: bricks[i].close, entryIdx: i, stop };
      }
    }
  }
  if (position) trades.push(closeTrade(bricks, position, bricks.length - 1, 'EOD_SQUARE_OFF', bricks[bricks.length - 1].close));
  return trades;
}

function closeTrade(bricks, position, exitIdx, action, exitPrice) {
  const grossPnlPerShare = position.entry - exitPrice; // SHORT: profit when exit < entry
  const grossPnlRupees = grossPnlPerShare * QTY;
  const costRs = costRupees(position.entry, exitPrice, QTY);
  const netPnlRupees = grossPnlRupees - costRs;
  return {
    symbol: SYMBOL,
    date: istDateStr(bricks[position.entryIdx].timestampMs),
    direction: 'SHORT',
    entry: position.entry,
    exitPrice,
    action,
    barsHeld: exitIdx - position.entryIdx,
    grossPnlRupees,
    costRupees: costRs,
    netPnlRupees,
    pnlPct: (grossPnlPerShare / position.entry) * 100,
  };
}

const darvas = strategies.find((s) => s.name === 'DarvasBox');
const results = {};

for (const pct of [0.3, 0.5, 0.75, 1.0, 1.5]) {
  const brickPct = pct / 100;
  const bricks = buildRenkoBricks(fiveMin, brickPct);
  const ctx = buildIndicatorContext(bricks);
  const allTrades = runShortOnly(ctx, darvas);
  const trades = allTrades.filter((t) => t.date >= POSITION_START);

  const n = trades.length;
  const wins = trades.filter((t) => t.netPnlRupees > 0).length;
  const totalNetRupees = trades.reduce((s, t) => s + t.netPnlRupees, 0);
  const totalGrossRupees = trades.reduce((s, t) => s + t.grossPnlRupees, 0);
  const totalCostRupees = trades.reduce((s, t) => s + t.costRupees, 0);

  results[pct] = { trades, n, wins, totalNetRupees, totalGrossRupees, totalCostRupees };

  console.log(`\n=== Brick ${pct}% ===`);
  console.log(`Bricks: ${bricks.length}, trades since ${POSITION_START}: ${n}`);
  if (n === 0) { console.log('No SHORT trades in window.'); continue; }
  console.log(`Wins: ${wins}/${n} (${(wins / n * 100).toFixed(1)}%)`);
  console.log(`Gross P&L: Rs ${totalGrossRupees.toFixed(2)}  Costs: Rs ${totalCostRupees.toFixed(2)}  Net P&L: Rs ${totalNetRupees.toFixed(2)}`);
  console.log(`Return on original investment (Rs ${(AVG_BUY * QTY).toFixed(2)}): ${(totalNetRupees / (AVG_BUY * QTY) * 100).toFixed(2)}%`);
}

fs.writeFileSync(path.join(__dirname, 'rvnl_short_overlay_results.json'), JSON.stringify(results, null, 1));
console.log('\nWritten rvnl_short_overlay_results.json');
