'use strict';

/**
 * Tests 3 concepts from a Bollinger-Bands-strategy source against ORB's
 * own genuinely ambiguous points, as isolated toggles so each can be
 * evaluated independently before considering combining any of them:
 *
 *   USE_VWAP_FILTER=1     -- require price above VWAP for LONG entries,
 *                            below VWAP for SHORT (source: "price should
 *                            be above VWAP for long entries").
 *   USE_TRAILING_EXIT=1   -- once a trade is TRAIL_ACTIVATE_PCT in profit,
 *                            trail the stop using each subsequent bar's
 *                            low (LONG) / high (SHORT) instead of waiting
 *                            for the fixed 2% target (source: "stay in
 *                            while price clings to the band, exit when it
 *                            creates distance").
 *   USE_EXTREME_EXIT=1    -- if the breakout bar's volume ratio exceeds
 *                            EXTREME_VOLUME_MULT (proxy for "an
 *                            exceptionally large candle" -- the source
 *                            gives no fixed threshold, this is a disclosed
 *                            proxy using a metric ORB already computes),
 *                            use a reduced target for faster profit-taking
 *                            instead of the full 2% (source: "book profits
 *                            immediately" on an extreme move).
 *
 * Same OR-breakout + 30x-volume entry trigger, same walk-forward/stop-
 * assumed-first convention as scan_orb.js -- only the confirmation gate
 * and exit mechanics change.
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, 'intraday_1min_cache.json');
const OR_MINUTES = 15;
const TARGET_PCT = 0.02;
const MAX_STOP_PCT = 0.02;
const VOLUME_MULT = 30;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const OR_END_MIN = MARKET_OPEN_MIN + OR_MINUTES;
const ENTRY_CUTOFF_MIN = 15 * 60 + 15; // no new entries after 15:15 IST -- too little of the session left to let a band-hugging exit run

const USE_VWAP_FILTER = process.env.USE_VWAP_FILTER === '1';
const USE_TRAILING_EXIT = process.env.USE_TRAILING_EXIT === '1';
const USE_EXTREME_EXIT = process.env.USE_EXTREME_EXIT === '1';
const TRAIL_ACTIVATE_PCT = parseFloat(process.env.TRAIL_ACTIVATE_PCT || '1') / 100;
const EXTREME_VOLUME_MULT = parseFloat(process.env.EXTREME_VOLUME_MULT || '100');
const EXTREME_TARGET_PCT = parseFloat(process.env.EXTREME_TARGET_PCT || '1') / 100;

// Actual Bollinger Bands (20-period SMA +/- 2 stddev on the 1-min close
// series -- standard BB parameters, applied to ORB's native 1-min bars
// since that's the data it already operates on). Two DISTINCT toggles,
// since the source describes two different uses of the bands:
const USE_BB_TREND_FILTER = process.env.USE_BB_TREND_FILTER === '1'; // require close vs 20 SMA (middle band), same role as the VWAP filter but using the actual Bollinger middle band
const USE_BB_HUGGING_EXIT = process.env.USE_BB_HUGGING_EXIT === '1'; // real "band hugging": exit when price stops touching the outer band, not a generic bar-low/high trail
const BB_PERIOD = parseInt(process.env.BB_PERIOD || '20', 10);
const BB_STDDEV_MULT = parseFloat(process.env.BB_STDDEV_MULT || '2');
const BB_TOUCH_TOLERANCE_PCT = parseFloat(process.env.BB_TOUCH_TOLERANCE_PCT || '0.1') / 100; // within 0.1% of the band counts as "touching"

/** Standard Bollinger Bands: 20-period SMA +/- 2 stddev, on the close series. Returns { upper, middle, lower } arrays parallel to candles, null before BB_PERIOD bars exist. */
function computeBollingerBands(dayCandles) {
  const n = dayCandles.length;
  const upper = new Array(n).fill(null);
  const middle = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  for (let i = BB_PERIOD - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - BB_PERIOD + 1; j <= i; j++) sum += dayCandles[j].close;
    const sma = sum / BB_PERIOD;
    let sqDiffSum = 0;
    for (let j = i - BB_PERIOD + 1; j <= i; j++) sqDiffSum += (dayCandles[j].close - sma) ** 2;
    const stddev = Math.sqrt(sqDiffSum / BB_PERIOD);
    middle[i] = sma;
    upper[i] = sma + BB_STDDEV_MULT * stddev;
    lower[i] = sma - BB_STDDEV_MULT * stddev;
  }
  return { upper, middle, lower };
}

function istMinutesOfDay(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function istDateStr(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

function groupByDay(candles) {
  const byDay = new Map();
  for (const c of candles) {
    const day = istDateStr(c.timestampMs);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(c);
  }
  return byDay;
}

/** Intraday cumulative VWAP, resetting at market open each day: cumsum(typicalPrice*volume) / cumsum(volume). */
function computeVwapSeries(dayCandles) {
  const vwap = new Array(dayCandles.length).fill(null);
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < dayCandles.length; i++) {
    const c = dayCandles[i];
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
    vwap[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return vwap;
}

function simulateDay(dayCandles) {
  dayCandles.sort((a, b) => a.timestampMs - b.timestampMs);
  const vwapSeries = computeVwapSeries(dayCandles);
  const bb = (USE_BB_TREND_FILTER || USE_BB_HUGGING_EXIT) ? computeBollingerBands(dayCandles) : null;

  const orBars = dayCandles.filter((c) => {
    const m = istMinutesOfDay(c.timestampMs);
    return m >= MARKET_OPEN_MIN && m < OR_END_MIN;
  });
  if (orBars.length < OR_MINUTES - 2) return null;

  const orHigh = Math.max(...orBars.map((c) => c.high));
  const orLow = Math.min(...orBars.map((c) => c.low));
  const avgORVolume = orBars.reduce((s, c) => s + c.volume, 0) / orBars.length;
  const volumeThreshold = avgORVolume * VOLUME_MULT;

  const afterOR = dayCandles.filter((c) => istMinutesOfDay(c.timestampMs) >= OR_END_MIN);
  if (afterOR.length === 0) return null;
  const afterOROffset = dayCandles.length - afterOR.length;

  let breakoutIdx = -1;
  let direction = null;
  let breakoutVolumeRatio = null;
  for (let i = 0; i < afterOR.length; i++) {
    const c = afterOR[i];
    if (istMinutesOfDay(c.timestampMs) >= ENTRY_CUTOFF_MIN) break; // candles are time-sorted, so no later bar can qualify either
    const brokeUp = c.high > orHigh;
    const brokeDown = c.low < orLow;
    if (brokeUp && brokeDown) continue;

    if (brokeUp) {
      if (c.volume < volumeThreshold) continue;
      if (USE_VWAP_FILTER) {
        const vwap = vwapSeries[afterOROffset + i];
        if (vwap == null || c.close <= vwap) continue; // require price above VWAP for LONG
      }
      if (USE_BB_TREND_FILTER) {
        const mid = bb.middle[afterOROffset + i];
        if (mid == null || c.close <= mid) continue; // require price above the Bollinger middle band (20 SMA) for LONG
      }
      breakoutIdx = i; direction = 'LONG'; breakoutVolumeRatio = c.volume / avgORVolume; break;
    }
    if (brokeDown) {
      if (c.volume < volumeThreshold) continue;
      if (USE_VWAP_FILTER) {
        const vwap = vwapSeries[afterOROffset + i];
        if (vwap == null || c.close >= vwap) continue; // require price below VWAP for SHORT
      }
      if (USE_BB_TREND_FILTER) {
        const mid = bb.middle[afterOROffset + i];
        if (mid == null || c.close >= mid) continue; // require price below the Bollinger middle band (20 SMA) for SHORT
      }
      breakoutIdx = i; direction = 'SHORT'; breakoutVolumeRatio = c.volume / avgORVolume; break;
    }
  }
  if (breakoutIdx === -1) return { noBreakout: true };

  const entry = direction === 'LONG' ? orHigh : orLow;
  const stopLevel = direction === 'LONG' ? orLow : orHigh;
  const stopPct = Math.abs(entry - stopLevel) / entry;
  if (stopPct > MAX_STOP_PCT) return { skippedWideStop: true };

  const isExtreme = USE_EXTREME_EXIT && breakoutVolumeRatio >= EXTREME_VOLUME_MULT;
  const targetPct = isExtreme ? EXTREME_TARGET_PCT : TARGET_PCT;
  const target = direction === 'LONG' ? entry * (1 + targetPct) : entry * (1 - targetPct);

  let trailingStop = stopLevel;
  let trailActivated = false;
  let hasHuggedBand = false; // BB hugging: has price touched the outer band at least once since entry?

  for (let i = breakoutIdx; i < afterOR.length; i++) {
    const c = afterOR[i];
    const currentStop = USE_TRAILING_EXIT ? trailingStop : stopLevel;
    const hitStop = direction === 'LONG' ? c.low <= currentStop : c.high >= currentStop;
    const hitTarget = direction === 'LONG' ? c.high >= target : c.low <= target;

    if (hitStop) {
      const action = USE_TRAILING_EXIT && trailActivated ? 'TRAILING_STOP' : 'STOP_LOSS';
      return { direction, entry, target, stop: stopLevel, stopPct: stopPct * 100, breakoutVolumeRatio, isExtreme, action, exitPrice: currentStop, barsHeld: i - breakoutIdx };
    }

    // Real "band hugging" exit: once price has touched the outer band, stay in
    // as long as each new bar still reaches (within tolerance of) that band;
    // exit the moment a bar fails to -- "creates distance" per the source.
    if (USE_BB_HUGGING_EXIT && bb.upper[afterOROffset + i] != null) {
      const outerBand = direction === 'LONG' ? bb.upper[afterOROffset + i] : bb.lower[afterOROffset + i];
      const tolerance = outerBand * BB_TOUCH_TOLERANCE_PCT;
      const touchingNow = direction === 'LONG' ? c.high >= outerBand - tolerance : c.low <= outerBand + tolerance;
      if (touchingNow) {
        hasHuggedBand = true;
      } else if (hasHuggedBand) {
        // was hugging, now created distance -> exit at this bar's close
        return { direction, entry, target, stop: stopLevel, stopPct: stopPct * 100, breakoutVolumeRatio, isExtreme, action: 'BAND_DISTANCE_EXIT', exitPrice: c.close, barsHeld: i - breakoutIdx };
      }
    }

    if (hitTarget && !USE_TRAILING_EXIT && !USE_BB_HUGGING_EXIT) {
      return { direction, entry, target, stop: stopLevel, stopPct: stopPct * 100, breakoutVolumeRatio, isExtreme, action: 'TARGET_HIT', exitPrice: target, barsHeld: i - breakoutIdx };
    }

    if (USE_TRAILING_EXIT) {
      const profitPct = direction === 'LONG' ? (c.close - entry) / entry : (entry - c.close) / entry;
      if (!trailActivated && profitPct >= TRAIL_ACTIVATE_PCT) trailActivated = true;
      if (trailActivated) {
        // ratchet the trailing stop using this bar's low (LONG) / high (SHORT), never loosening it
        trailingStop = direction === 'LONG' ? Math.max(trailingStop, c.low) : Math.min(trailingStop, c.high);
      }
    }
  }

  const last = afterOR[afterOR.length - 1];
  return { direction, entry, target, stop: stopLevel, stopPct: stopPct * 100, breakoutVolumeRatio, isExtreme, action: 'EOD_SQUARE_OFF', exitPrice: last.close, barsHeld: afterOR.length - 1 - breakoutIdx };
}

function main() {
  if (!fs.existsSync(CACHE_PATH)) {
    console.error('intraday_1min_cache.json not found — run fetch_orb_universe.js first.');
    process.exit(1);
  }
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));

  const trades = [];
  let totalDays = 0, noBreakoutDays = 0, skippedWideStopDays = 0;

  for (const [symbol, candles] of Object.entries(cache)) {
    const byDay = groupByDay(candles);
    for (const [day, dayCandles] of byDay.entries()) {
      const result = simulateDay(dayCandles);
      if (!result) continue;
      totalDays++;
      if (result.noBreakout) { noBreakoutDays++; continue; }
      if (result.skippedWideStop) { skippedWideStopDays++; continue; }

      const pnlPct = result.direction === 'LONG' ? ((result.exitPrice - result.entry) / result.entry) * 100 : ((result.entry - result.exitPrice) / result.entry) * 100;
      trades.push({ symbol, date: day, ...result, pnlPct });
    }
  }

  console.log(`VWAP filter: ${USE_VWAP_FILTER}  Trailing exit: ${USE_TRAILING_EXIT} (activate @${(TRAIL_ACTIVATE_PCT*100).toFixed(1)}%)  Extreme exit: ${USE_EXTREME_EXIT} (>=${EXTREME_VOLUME_MULT}x -> ${(EXTREME_TARGET_PCT*100).toFixed(1)}% target)`);
  console.log(`BB trend filter (vs 20 SMA): ${USE_BB_TREND_FILTER}  BB hugging exit: ${USE_BB_HUGGING_EXIT} (period=${BB_PERIOD}, ${BB_STDDEV_MULT}stddev, touch tolerance=${(BB_TOUCH_TOLERANCE_PCT*100).toFixed(2)}%)`);
  console.log(`Total (symbol,day) combos: ${totalDays}  No breakout: ${noBreakoutDays}  Stop too wide: ${skippedWideStopDays}`);
  console.log(`Trades taken: ${trades.length}\n`);

  if (trades.length === 0) { console.log('No trades.'); return; }

  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const avg = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
  const byAction = {};
  for (const t of trades) byAction[t.action] = (byAction[t.action] || 0) + 1;

  console.log(`Win rate: ${((wins / trades.length) * 100).toFixed(1)}%`);
  console.log(`Avg P&L per trade (gross): ${avg >= 0 ? '+' : ''}${avg.toFixed(3)}%`);
  console.log(`Exit breakdown: ${JSON.stringify(byAction)}`);

  fs.writeFileSync(path.join(__dirname, 'trades_orb_bb_enhanced.json'), JSON.stringify(trades, null, 1));
  console.log('\nWritten trades_orb_bb_enhanced.json');
}

main();
