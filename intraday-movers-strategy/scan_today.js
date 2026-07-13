'use strict';

/**
 * Fetches TODAY's 1-minute candles for the 158-stock ORB universe and runs
 * the recommended settings (30x volume confirmation, 2% target, 2% stop
 * cap, both directions) against just today, reusing simulateDay from
 * scan_orb.js's logic directly (kept in sync by requiring the same file's
 * exported internals would be cleaner, but scan_orb.js is a standalone
 * script — duplicated here deliberately minimal to avoid refactoring a
 * working, already-validated backtest script).
 */

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = '/private/tmp/claude-501/-Users-adilrizwan-Downloads/fef5c952-3a52-453b-aac2-05d44213f064/scratchpad/.secrets/upstox_token.txt';
const TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const UPSTOX_BASE = 'https://api.upstox.com/v2';

const symbols353 = require('../ema-scalp-strategy/symbols.json');
const cache = require('../swing-strategy/mtf_candle_cache.json');

const OR_MINUTES = 15;
const TARGET_PCT = 0.02;
const MAX_STOP_PCT = 0.02;
const VOLUME_MULT = 30;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istMinutesOfDay(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
const MARKET_OPEN_MIN = 9 * 60 + 15;
const OR_END_MIN = MARKET_OPEN_MIN + OR_MINUTES;

function buildBand() {
  const results = [];
  for (const symbol of Object.keys(symbols353)) {
    const tf = cache[symbol];
    if (!tf || !tf.day || tf.day.length < 40) continue;
    const recent = tf.day.slice(-40);
    const ranges = recent.map((c) => ((c.high - c.low) / c.open) * 100);
    const avgRange = ranges.reduce((s, v) => s + v, 0) / ranges.length;
    if (avgRange >= 1.5 && avgRange < 3) results.push(symbol);
  }
  return results;
}

async function fetchToday(instrumentKey, dateStr) {
  const url = `${UPSTOX_BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/1minute/${dateStr}/${dateStr}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const raw = body?.data?.candles || [];
  return raw
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function simulateDay(dayCandles) {
  dayCandles.sort((a, b) => a.timestampMs - b.timestampMs);
  const orBars = dayCandles.filter((c) => {
    const m = istMinutesOfDay(c.timestampMs);
    return m >= MARKET_OPEN_MIN && m < OR_END_MIN;
  });
  if (orBars.length < OR_MINUTES - 2) return { insufficientData: true };

  const orHigh = Math.max(...orBars.map((c) => c.high));
  const orLow = Math.min(...orBars.map((c) => c.low));
  const avgORVolume = orBars.reduce((s, c) => s + c.volume, 0) / orBars.length;
  const volumeThreshold = avgORVolume * VOLUME_MULT;

  const afterOR = dayCandles.filter((c) => istMinutesOfDay(c.timestampMs) >= OR_END_MIN);
  if (afterOR.length === 0) return { insufficientData: true };

  let breakoutIdx = -1;
  let direction = null;
  let breakoutVolumeRatio = null;
  for (let i = 0; i < afterOR.length; i++) {
    const c = afterOR[i];
    const brokeUp = c.high > orHigh;
    const brokeDown = c.low < orLow;
    if (brokeUp && brokeDown) continue;
    if (brokeUp) {
      if (c.volume < volumeThreshold) continue;
      breakoutIdx = i; direction = 'LONG'; breakoutVolumeRatio = c.volume / avgORVolume; break;
    }
    if (brokeDown) {
      if (c.volume < volumeThreshold) continue;
      breakoutIdx = i; direction = 'SHORT'; breakoutVolumeRatio = c.volume / avgORVolume; break;
    }
  }
  if (breakoutIdx === -1) return { noBreakout: true, orHigh, orLow };

  const entry = direction === 'LONG' ? orHigh : orLow;
  const stopLevel = direction === 'LONG' ? orLow : orHigh;
  const stopPct = Math.abs(entry - stopLevel) / entry;
  if (stopPct > MAX_STOP_PCT) return { skippedWideStop: true, orHigh, orLow };

  const target = direction === 'LONG' ? entry * (1 + TARGET_PCT) : entry * (1 - TARGET_PCT);

  for (let i = breakoutIdx; i < afterOR.length; i++) {
    const c = afterOR[i];
    const hitStop = direction === 'LONG' ? c.low <= stopLevel : c.high >= stopLevel;
    const hitTarget = direction === 'LONG' ? c.high >= target : c.low <= target;
    if (hitStop) return { direction, entry, target, stop: stopLevel, stopPct: stopPct * 100, breakoutVolumeRatio, action: 'STOP_LOSS', exitPrice: stopLevel, barsHeld: i - breakoutIdx };
    if (hitTarget) return { direction, entry, target, stop: stopLevel, stopPct: stopPct * 100, breakoutVolumeRatio, action: 'TARGET_HIT', exitPrice: target, barsHeld: i - breakoutIdx };
  }
  const last = afterOR[afterOR.length - 1];
  return { direction, entry, target, stop: stopLevel, stopPct: stopPct * 100, breakoutVolumeRatio, action: 'STILL_OPEN_OR_EOD', exitPrice: last.close, barsHeld: afterOR.length - 1 - breakoutIdx };
}

async function main() {
  const today = process.env.SCAN_DATE || new Date().toISOString().slice(0, 10);
  const band = buildBand();
  console.log(`Scanning ${band.length} stocks for ${today} (recommended settings: 30x volume, 2% target, 2% stop cap)...\n`);

  const results = [];
  let ok = 0;
  for (const symbol of band) {
    try {
      const candles = await fetchToday(symbols353[symbol], today);
      if (candles.length === 0) continue;
      ok++;
      const r = simulateDay(candles);
      if (r.direction) {
        const pnlPct = r.direction === 'LONG' ? ((r.exitPrice - r.entry) / r.entry) * 100 : ((r.entry - r.exitPrice) / r.entry) * 100;
        results.push({ symbol, ...r, pnlPct });
      }
      await new Promise((res) => setTimeout(res, 100));
    } catch (e) {
      console.warn(`  FAILED ${symbol}: ${e.message}`);
    }
  }
  console.log(`Fetched data for ${ok}/${band.length} stocks.\n`);

  if (results.length === 0) {
    console.log('No qualifying signals today.');
  } else {
    console.log(`${results.length} qualifying signal(s) today:\n`);
    for (const r of results) {
      console.log(
        `  ${r.symbol.padEnd(12)} ${r.direction.padEnd(5)} entry=${r.entry.toFixed(2)} stop=${r.stop.toFixed(2)} target=${r.target.toFixed(2)} volRatio=${r.breakoutVolumeRatio.toFixed(1)}x` +
          `  -> ${r.action} @ ${r.exitPrice.toFixed(2)}  P&L=${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(2)}%`
      );
    }
  }

  fs.writeFileSync(path.join(__dirname, `today_${today}.json`), JSON.stringify(results, null, 1));
  console.log(`\nWritten today_${today}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
