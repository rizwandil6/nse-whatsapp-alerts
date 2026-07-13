'use strict';

/**
 * "Prior-day top mover, gap continuation" intraday scalp — a new strategy,
 * built from scratch per direct request (capital Rs 50,000, intraday,
 * design left entirely to judgment). Concept:
 *
 *   Each trading day D, rank all stocks in the halal 353-stock universe by
 *   the PRIOR day's (D-1) close-to-close % return (uses only data known as
 *   of D-1's close — no lookahead). Take the single biggest gainer and
 *   single biggest loser. If day D's open continues that move (gaps further
 *   up for the gainer / further down for the loser), enter at D's open:
 *   LONG the gainer, SHORT the loser. Target +1%/-1% from entry (the
 *   requested number). Stop-loss tested across a small grid. Exit at
 *   whichever hits first using the day's own high/low (stop assumed to hit
 *   first on same-day overlap — the same conservative convention used
 *   throughout this project, since daily OHLC can't reveal true intraday
 *   sequence). If neither hits, square off at day's close — MANDATORY, no
 *   overnight hold (intraday only).
 *
 *   Reuses swing-strategy's existing 353-stock, 5-year daily cache directly
 *   — no new data fetching needed for this first pass. This means the
 *   "entry" and "exit" are approximated from DAILY bars (open/high/low/
 *   close), not true intraday tick sequencing — a real limitation, flagged
 *   in the README, to be refined with actual 1-minute data in a later pass
 *   if this concept looks promising enough to pursue further.
 */

const fs = require('fs');
const path = require('path');

const SWING_DIR = path.join(__dirname, '..', 'swing-strategy');
const CACHE_PATH = path.join(SWING_DIR, 'mtf_candle_cache.json');
const SYMBOLS_PATH = path.join(__dirname, '..', 'ema-scalp-strategy', 'symbols.json');

const STOP_PCT = parseFloat(process.env.STOP_PCT || '0.5') / 100; // e.g. 0.5 -> 0.005
const TARGET_PCT = 0.01; // fixed at the requested 1%

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const symbols353 = JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf8'));

  // Build a shared timestamp-indexed daily series per symbol, and a global
  // sorted list of unique trading dates across the universe.
  const bySymbol = {};
  const dateSet = new Set();
  for (const symbol of Object.keys(symbols353)) {
    const tf = cache[symbol];
    if (!tf || !tf.day || tf.day.length < 100) continue;
    bySymbol[symbol] = tf.day;
    for (const c of tf.day) dateSet.add(c.timestampMs);
  }
  const allDates = [...dateSet].sort((a, b) => a - b);

  // Index each symbol's candles by date for O(1) lookup per day.
  const indexBySymbol = {};
  for (const [symbol, candles] of Object.entries(bySymbol)) {
    const idx = new Map();
    candles.forEach((c, i) => idx.set(c.timestampMs, i));
    indexBySymbol[symbol] = idx;
  }

  const trades = [];

  // Start from the 2nd date (need a D-1 return) and walk forward.
  for (let d = 1; d < allDates.length; d++) {
    const today = allDates[d];
    const prevDate = allDates[d - 1];

    // Rank all symbols by D-1's close-to-close return (needs D-2 too).
    const returns = [];
    for (const [symbol, candles] of Object.entries(bySymbol)) {
      const idx = indexBySymbol[symbol];
      const iPrev = idx.get(prevDate);
      if (iPrev == null || iPrev < 1) continue;
      const prevClose = candles[iPrev].close;
      const prevPrevClose = candles[iPrev - 1].close;
      if (!prevPrevClose) continue;
      const ret = (prevClose - prevPrevClose) / prevPrevClose;
      returns.push({ symbol, ret, prevClose });
    }
    if (returns.length < 10) continue;
    returns.sort((a, b) => b.ret - a.ret);
    const topGainer = returns[0];
    const topLoser = returns[returns.length - 1];

    // FADE variant: same signal days as the continuation test (prior day's
    // top gainer gaps further up / top loser gaps further down), but bet on
    // reversal instead — SHORT the extended gainer, LONG the beaten-down
    // loser.
    for (const { candidate, direction, gapDirection } of [
      { candidate: topGainer, direction: 'SHORT', gapDirection: 'up' },
      { candidate: topLoser, direction: 'LONG', gapDirection: 'down' },
    ]) {
      const idx = indexBySymbol[candidate.symbol];
      const iToday = idx.get(today);
      if (iToday == null) continue;
      const todayCandle = bySymbol[candidate.symbol][iToday];
      const gapsFurther = gapDirection === 'up' ? todayCandle.open > candidate.prevClose : todayCandle.open < candidate.prevClose;
      if (!gapsFurther) continue;

      const entryPrice = todayCandle.open;
      const target = direction === 'LONG' ? entryPrice * (1 + TARGET_PCT) : entryPrice * (1 - TARGET_PCT);
      const stop = direction === 'LONG' ? entryPrice * (1 - STOP_PCT) : entryPrice * (1 + STOP_PCT);

      const hitStop = direction === 'LONG' ? todayCandle.low <= stop : todayCandle.high >= stop;
      const hitTarget = direction === 'LONG' ? todayCandle.high >= target : todayCandle.low <= target;

      let action, exitPrice;
      if (hitStop) {
        action = 'STOP_LOSS';
        exitPrice = stop;
      } else if (hitTarget) {
        action = 'TARGET_HIT';
        exitPrice = target;
      } else {
        action = 'EOD_SQUARE_OFF';
        exitPrice = todayCandle.close;
      }

      const pnlPct = direction === 'LONG' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;

      trades.push({
        symbol: candidate.symbol,
        direction,
        date: new Date(today).toISOString().slice(0, 10),
        priorDayReturn: candidate.ret * 100,
        entryPrice,
        stop,
        target,
        action,
        exitPrice,
        pnlPct,
      });
    }
  }

  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const avg = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
  const byAction = {};
  for (const t of trades) byAction[t.action] = (byAction[t.action] || 0) + 1;
  const byDirection = {};
  for (const dir of ['LONG', 'SHORT']) {
    const subset = trades.filter((t) => t.direction === dir);
    if (!subset.length) continue;
    const w = subset.filter((t) => t.pnlPct > 0).length;
    const a = subset.reduce((s, t) => s + t.pnlPct, 0) / subset.length;
    byDirection[dir] = { n: subset.length, win: ((w / subset.length) * 100).toFixed(1) + '%', avg: (a >= 0 ? '+' : '') + a.toFixed(3) + '%' };
  }

  console.log(`Stop = ${(STOP_PCT * 100).toFixed(2)}%, Target = ${(TARGET_PCT * 100).toFixed(2)}%`);
  console.log(`Total trades: ${trades.length} (over ${allDates.length} trading days in cache)`);
  console.log(`Win rate: ${((wins / trades.length) * 100).toFixed(1)}%`);
  console.log(`Avg P&L per trade (gross): ${avg >= 0 ? '+' : ''}${avg.toFixed(3)}%`);
  console.log(`Exit breakdown: ${JSON.stringify(byAction)}`);
  console.log(`By direction: ${JSON.stringify(byDirection, null, 1)}`);

  fs.writeFileSync(path.join(__dirname, 'trades.json'), JSON.stringify(trades, null, 1));
  console.log('\nWritten trades.json');
}

main();
