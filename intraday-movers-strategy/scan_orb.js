'use strict';

/**
 * Opening Range Breakout (ORB) backtest — a genuinely different signal
 * mechanism from everything else in this project (not zones, not EMA
 * cross, not candle patterns, not prior-day movers). Uses the moderate-
 * volatility universe (1.5%-3% avg daily range, see fetch_orb_universe.js)
 * and REAL 1-minute intraday bars, so target/stop hit-order is genuine
 * chronological sequencing — not the daily-OHLC "stop assumed first"
 * approximation used in the earlier (failed) prior-day-mover test.
 *
 * Mechanic per (symbol, trading day):
 *   - Opening range = first 15 minutes after 9:15 IST open (9:15-9:29).
 *   - First breakout of that range (either side, whichever comes first
 *     chronologically) triggers entry at the range boundary: LONG if price
 *     breaks above the OR high, SHORT if below the OR low. Only one trade
 *     per stock per day.
 *   - Target: 1% from entry (the requested number).
 *   - Stop: the OPPOSITE side of the opening range — a structural stop,
 *     not an arbitrary fixed %, since fixed stops proved to be the wrong
 *     tool against real intraday volatility in the prior test.
 *   - MAX_STOP_PCT optionally skips a trade if that structural stop would
 *     be wider than a sane risk:reward vs the 1% target (default 1.5%).
 *   - Walk forward bar-by-bar (real sequencing) until target/stop/EOD.
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, 'intraday_1min_cache.json');
const OR_MINUTES = 15;
const TARGET_PCT = parseFloat(process.env.TARGET_PCT || '1') / 100;
const MAX_STOP_PCT = parseFloat(process.env.MAX_STOP_PCT || '1.5') / 100;
const VOLUME_MULT = parseFloat(process.env.VOLUME_MULT || '0'); // 0 = no volume filter
const SHORT_ONLY = process.env.SHORT_ONLY === '1';
const LONG_ONLY = process.env.LONG_ONLY === '1';
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istMinutesOfDay(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function istDateStr(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

const MARKET_OPEN_MIN = 9 * 60 + 15;
const OR_END_MIN = MARKET_OPEN_MIN + OR_MINUTES;

function groupByDay(candles) {
  const byDay = new Map();
  for (const c of candles) {
    const day = istDateStr(c.timestampMs);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(c);
  }
  return byDay;
}

function simulateDay(dayCandles) {
  dayCandles.sort((a, b) => a.timestampMs - b.timestampMs);
  const orBars = dayCandles.filter((c) => {
    const m = istMinutesOfDay(c.timestampMs);
    return m >= MARKET_OPEN_MIN && m < OR_END_MIN;
  });
  if (orBars.length < OR_MINUTES - 2) return null; // incomplete data for this day

  const orHigh = Math.max(...orBars.map((c) => c.high));
  const orLow = Math.min(...orBars.map((c) => c.low));
  const avgORVolume = orBars.reduce((s, c) => s + c.volume, 0) / orBars.length;
  const volumeThreshold = avgORVolume * VOLUME_MULT;

  const afterOR = dayCandles.filter((c) => istMinutesOfDay(c.timestampMs) >= OR_END_MIN);
  if (afterOR.length === 0) return null;

  let breakoutIdx = -1;
  let direction = null;
  let breakoutVolumeRatio = null;
  for (let i = 0; i < afterOR.length; i++) {
    const c = afterOR[i];
    const brokeUp = c.high > orHigh;
    const brokeDown = c.low < orLow;
    if (brokeUp && brokeDown) {
      // Same bar broke both sides — ambiguous which came first on a 1-min
      // bar; skip rather than guess (rare, wide bars only).
      continue;
    }
    if (brokeUp && !SHORT_ONLY) {
      if (VOLUME_MULT > 0 && c.volume < volumeThreshold) continue; // unconfirmed, keep scanning
      breakoutIdx = i; direction = 'LONG'; breakoutVolumeRatio = c.volume / avgORVolume; break;
    }
    if (brokeDown && !LONG_ONLY) {
      if (VOLUME_MULT > 0 && c.volume < volumeThreshold) continue; // unconfirmed, keep scanning
      breakoutIdx = i; direction = 'SHORT'; breakoutVolumeRatio = c.volume / avgORVolume; break;
    }
  }
  if (breakoutIdx === -1) return { noBreakout: true };

  const entry = direction === 'LONG' ? orHigh : orLow;
  const stopLevel = direction === 'LONG' ? orLow : orHigh;
  const stopPct = Math.abs(entry - stopLevel) / entry;
  if (stopPct > MAX_STOP_PCT) return { skippedWideStop: true };

  const target = direction === 'LONG' ? entry * (1 + TARGET_PCT) : entry * (1 - TARGET_PCT);

  for (let i = breakoutIdx; i < afterOR.length; i++) {
    const c = afterOR[i];
    const hitStop = direction === 'LONG' ? c.low <= stopLevel : c.high >= stopLevel;
    const hitTarget = direction === 'LONG' ? c.high >= target : c.low <= target;
    // Same-bar overlap: conservative, stop assumed first (matches project convention).
    if (hitStop) {
      return { direction, entry, target, stop: stopLevel, stopPct: stopPct * 100, breakoutVolumeRatio, action: 'STOP_LOSS', exitPrice: stopLevel, barsHeld: i - breakoutIdx };
    }
    if (hitTarget) {
      return { direction, entry, target, stop: stopLevel, stopPct: stopPct * 100, breakoutVolumeRatio, action: 'TARGET_HIT', exitPrice: target, barsHeld: i - breakoutIdx };
    }
  }
  const last = afterOR[afterOR.length - 1];
  return { direction, entry, target, stop: stopLevel, stopPct: stopPct * 100, breakoutVolumeRatio, action: 'EOD_SQUARE_OFF', exitPrice: last.close, barsHeld: afterOR.length - 1 - breakoutIdx };
}

function main() {
  if (!fs.existsSync(CACHE_PATH)) {
    console.error('intraday_1min_cache.json not found yet — run fetch_orb_universe.js first.');
    process.exit(1);
  }
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));

  const trades = [];
  let totalDays = 0;
  let noBreakoutDays = 0;
  let skippedWideStopDays = 0;

  for (const [symbol, candles] of Object.entries(cache)) {
    const byDay = groupByDay(candles);
    for (const [day, dayCandles] of byDay.entries()) {
      const result = simulateDay(dayCandles);
      if (!result) continue;
      totalDays++;
      if (result.noBreakout) { noBreakoutDays++; continue; }
      if (result.skippedWideStop) { skippedWideStopDays++; continue; }

      const pnlPct =
        result.direction === 'LONG'
          ? ((result.exitPrice - result.entry) / result.entry) * 100
          : ((result.entry - result.exitPrice) / result.entry) * 100;

      trades.push({ symbol, date: day, ...result, pnlPct });
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
  const stopPcts = trades.map((t) => t.stopPct).sort((a, b) => a - b);
  const avgStopPct = stopPcts.reduce((s, v) => s + v, 0) / (stopPcts.length || 1);

  console.log(`Target: ${(TARGET_PCT * 100).toFixed(1)}%  Max structural stop: ${(MAX_STOP_PCT * 100).toFixed(1)}%  Volume mult: ${VOLUME_MULT || 'off'}  Short-only: ${SHORT_ONLY}`);
  console.log(`Total (symbol,day) combos with usable data: ${totalDays}`);
  console.log(`  No breakout either side: ${noBreakoutDays} (${((noBreakoutDays / totalDays) * 100).toFixed(1)}%)`);
  console.log(`  Skipped — structural stop too wide: ${skippedWideStopDays} (${((skippedWideStopDays / totalDays) * 100).toFixed(1)}%)`);
  console.log(`  Trades taken: ${trades.length} (${((trades.length / totalDays) * 100).toFixed(1)}% of days)`);
  console.log();
  console.log(`Win rate: ${((wins / trades.length) * 100).toFixed(1)}%`);
  console.log(`Avg P&L per trade (gross): ${avg >= 0 ? '+' : ''}${avg.toFixed(3)}%`);
  console.log(`Avg structural stop distance: ${avgStopPct.toFixed(2)}%`);
  console.log(`Exit breakdown: ${JSON.stringify(byAction)}`);
  console.log(`By direction: ${JSON.stringify(byDirection, null, 1)}`);

  fs.writeFileSync(path.join(__dirname, 'trades_orb.json'), JSON.stringify(trades, null, 1));
  console.log('\nWritten trades_orb.json');
}

main();
