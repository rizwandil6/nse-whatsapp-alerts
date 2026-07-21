'use strict';

/**
 * Backtest runner for the 12 Renko-based strategies in strategies.js.
 * Uses ONLY the cached data from ../renko-strategy/ (intraday_cache.json,
 * symbols.json) -- no code, indicators, Renko logic, or signal rules from
 * that directory are imported or reused; everything here is freshly built
 * (renko.js, indicators.js, strategies.js in this directory).
 *
 * Trade-level conventions (general intraday-equity domain conventions,
 * applied uniformly across all 12 strategies, not specific to any
 * existing strategy in this repo):
 *   - One position at a time per (symbol, strategy).
 *   - Forced EOD square-off: any open position is closed at the previous
 *     brick's close the moment a new IST calendar day's first brick
 *     appears (Renko bricks themselves are NOT reset daily -- only the
 *     TRADE is day-bound, consistent with equity intraday MIS trading).
 *   - Stop-loss checked every brick from the bar after entry: LONG stops
 *     out if a 'down' brick's low <= stop; SHORT if an 'up' brick's high >= stop.
 *   - Entry price = the signal brick's close (the price at which the
 *     condition was actually confirmed).
 */

const fs = require('fs');
const path = require('path');
const { buildRenkoBricks } = require('./renko');
const { stochastic, bollinger, donchian, dmi, awesomeOscillator, sma, applyOffset } = require('./indicators');
const { strategies } = require('./strategies');

const CACHE_PATH = path.join(__dirname, '..', 'renko-strategy', 'intraday_cache.json');
const SYMBOLS_PATH = path.join(__dirname, '..', 'renko-strategy', 'symbols.json');
// 0.5% chosen (not 1.5% used elsewhere in this repo) because several
// indicators here need 50+ periods of BRICK warm-up (Donchian 52+offset 10,
// SMA50, DMI(50) combo) -- at 1.5% brick size this dataset (60 trading
// days, 5-min bars) produces a median of only 40 bricks/symbol, well below
// that warm-up, excluding 77% of the universe outright. At 0.5% the median
// is 271 bricks/symbol and only 3/352 symbols fall short of 100 bricks.
const BRICK_PCT = parseFloat(process.env.BRICK_PCT || '0.5') / 100;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istDateStr(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
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
  const sma10 = sma(closes, 10);
  const sma10Offset = applyOffset(sma10, 5);
  return { bricks, stoch, bbands, donch, dmi14, dmi50, ao, sma50, sma20, sma10Offset };
}

function runStrategyOnSymbol(symbol, ctx, strategy) {
  const { bricks } = ctx;
  const trades = [];
  let position = null; // { direction, entry, entryIdx, stop, target, trailStop }

  for (let i = 1; i < bricks.length; i++) {
    const dayChanged = istDateStr(bricks[i].timestampMs) !== istDateStr(bricks[i - 1].timestampMs);

    if (position) {
      if (dayChanged) {
        trades.push(closeTrade(symbol, strategy.name, bricks, position, i - 1, 'EOD_SQUARE_OFF', bricks[i - 1].close));
        position = null;
      } else {
        const b = bricks[i];
        const stopHit = position.direction === 'LONG'
          ? (b.direction === 'down' && b.low <= position.stop)
          : (b.direction === 'up' && b.high >= position.stop);
        if (stopHit) {
          trades.push(closeTrade(symbol, strategy.name, bricks, position, i, 'STOP_LOSS', position.stop));
          position = null;
        } else {
          const exitReason = strategy.getExit(i, ctx, position);
          if (exitReason) {
            trades.push(closeTrade(symbol, strategy.name, bricks, position, i, exitReason, b.close));
            position = null;
          }
        }
      }
    }

    if (!position && !dayChanged) {
      const direction = strategy.getEntry(i, ctx);
      if (direction) {
        const stop = strategy.getStop(i, ctx, direction, i);
        if (stop != null) {
          position = { direction, entry: bricks[i].close, entryIdx: i, stop };
          if (strategy.getEntryExtra) Object.assign(position, strategy.getEntryExtra(i, ctx, direction));
        }
      }
    }
  }
  if (position) {
    trades.push(closeTrade(symbol, strategy.name, bricks, position, bricks.length - 1, 'EOD_SQUARE_OFF', bricks[bricks.length - 1].close));
  }
  return trades;
}

function closeTrade(symbol, strategyName, bricks, position, exitIdx, action, exitPrice) {
  const pnlPct = position.direction === 'LONG'
    ? ((exitPrice - position.entry) / position.entry) * 100
    : ((position.entry - exitPrice) / position.entry) * 100;
  return {
    symbol,
    strategy: strategyName,
    date: istDateStr(bricks[position.entryIdx].timestampMs),
    direction: position.direction,
    entry: position.entry,
    exitPrice,
    action,
    barsHeld: exitIdx - position.entryIdx,
    pnlPct,
  };
}

// ── Zerodha-style intraday MIS cost model, Rs 50,000 capital -- same
// publicly-documented fee schedule used elsewhere in this project, written
// fresh here rather than importing any existing apply_costs.js. ──
const CAPITAL = 50000;
function costPct(entry, exit, direction) {
  const qty = CAPITAL / entry;
  const entryValue = qty * entry;
  const exitValue = qty * exit;
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

function summarize(trades) {
  const n = trades.length;
  if (n === 0) return { n: 0 };
  let grossSum = 0, netSum = 0, wins = 0, netWins = 0;
  for (const t of trades) {
    const cost = costPct(t.entry, t.exitPrice, t.direction);
    const net = t.pnlPct - cost;
    grossSum += t.pnlPct;
    netSum += net;
    if (t.pnlPct > 0) wins++;
    if (net > 0) netWins++;
  }
  return {
    n,
    winPct: (wins / n) * 100,
    netWinPct: (netWins / n) * 100,
    grossAvg: grossSum / n,
    netAvg: netSum / n,
    grossSum,
    netSum,
  };
}

function main() {
  console.log(`Loading cache + symbols...`);
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const symbols = JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf8'));
  const symbolList = Object.keys(symbols).filter((s) => cache[s] && cache[s].fiveMin && cache[s].fiveMin.length > 0);
  console.log(`${symbolList.length} symbols with data. Brick size: ${(BRICK_PCT * 100).toFixed(2)}% of price.`);

  const allTradesByStrategy = {};
  for (const s of strategies) allTradesByStrategy[s.name] = [];

  let done = 0;
  for (const symbol of symbolList) {
    const candles = cache[symbol].fiveMin;
    const bricks = buildRenkoBricks(candles, BRICK_PCT);
    if (bricks.length < 100) { done++; continue; } // not enough bricks for indicator warm-up (Donchian 52 + offset 10, DMI 50, etc.)
    const ctx = buildIndicatorContext(bricks);
    for (const strategy of strategies) {
      const trades = runStrategyOnSymbol(symbol, ctx, strategy);
      allTradesByStrategy[strategy.name].push(...trades);
    }
    done++;
    if (done % 50 === 0) console.log(`  ...${done}/${symbolList.length} symbols processed`);
  }

  console.log(`\n=== Results across ${symbolList.length} symbols, ${BRICK_PCT * 100}% brick size, 60 trading days ===\n`);
  const results = [];
  for (const s of strategies) {
    const trades = allTradesByStrategy[s.name];
    const stats = summarize(trades);
    results.push({ name: s.name, ...stats });
    fs.writeFileSync(path.join(__dirname, `trades_${s.name}.json`), JSON.stringify(trades, null, 1));
  }

  results.sort((a, b) => (b.netAvg || -999) - (a.netAvg || -999));
  console.log('Strategy'.padEnd(32), 'Trades'.padStart(8), 'GrossWin%'.padStart(10), 'NetWin%'.padStart(9), 'GrossAvg%'.padStart(10), 'NetAvg%'.padStart(9));
  for (const r of results) {
    if (r.n === 0) { console.log(r.name.padEnd(32), 'no trades'); continue; }
    console.log(
      r.name.padEnd(32),
      String(r.n).padStart(8),
      r.winPct.toFixed(1).padStart(10),
      r.netWinPct.toFixed(1).padStart(9),
      (r.grossAvg >= 0 ? '+' : '') + r.grossAvg.toFixed(4).padStart(9),
      (r.netAvg >= 0 ? '+' : '') + r.netAvg.toFixed(4).padStart(8)
    );
  }
  fs.writeFileSync(path.join(__dirname, 'summary.json'), JSON.stringify(results, null, 1));
  console.log('\nPer-trade files: trades_<Strategy>.json. Summary: summary.json');
}

main();
