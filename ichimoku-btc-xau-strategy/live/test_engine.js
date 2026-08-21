'use strict';

/**
 * Offline self-test for the MTF Ichimoku engine -- no network, no DB, no
 * exchange connection. Drives MtfSymbolTracker with synthetic OHLC series
 * per timeframe (clean monotonic trends, which satisfy all the MTF alignment
 * conditions once enough lookback exists) and asserts SETUP -> WARNING /
 * OUTCOME(SL) / OUTCOME(TARGET), mirroring
 * ichimoku-momentum-strategy/live/test_engine.js's approach. Run: `npm test`.
 */

const assert = require('assert');
const { MtfSymbolTracker, TARGET_R } = require('./mtf_engine');

const FIVE_MIN = 5 * 60000;
const THIRTY_MIN = 30 * 60000;
const ONE_HOUR = 60 * 60000;
const START = Date.parse('2026-08-17T00:00:00Z');

/** A monotonic series (bullish if step>0, bearish if step<0) with small consistent wicks. */
function buildTrend(nBars, stepMs, startPx, step) {
  const bars = [];
  for (let g = 0; g < nBars; g++) {
    const close = startPx + g * step;
    const open = close - step * 0.2;
    const high = Math.max(open, close) + Math.abs(step) * 0.4;
    const low = Math.min(open, close) - Math.abs(step) * 0.4;
    bars.push({ timestampMs: START + g * stepMs, open, high, low, close, volume: 100 });
  }
  return bars;
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n     ${e.message}`); }
}

/** Build a tracker with fully-aligned bullish (or bearish) higher timeframes and a long m5 history. */
function buildAlignedTracker(symbol, direction) {
  const sign = direction === 'LONG' ? 1 : -1;
  const h1 = buildTrend(150, ONE_HOUR, 1000, sign * 2);
  const m30 = buildTrend(150, THIRTY_MIN, 1000, sign * 1.5);
  const m5 = buildTrend(260, FIVE_MIN, 1000, sign * 0.5); // >200 for EMA200 + gate lookback

  const tracker = new MtfSymbolTracker(symbol);
  tracker.seedHistory({ h1, m30, m5: m5.slice(0, m5.length - 1) });
  return { tracker, lastM5: m5[m5.length - 1], m5 };
}

// ---------------------------------------------------------------------------
// A: clean LONG alignment across all 3 timeframes -> SETUP fires with correct
//    stop/target math, and criteria are recorded.
// ---------------------------------------------------------------------------
check('LONG: aligned 1H/30m/5m produces a SETUP with 2R target and correct stop side', () => {
  const { tracker, lastM5 } = buildAlignedTracker('TESTLONG', 'LONG');
  const events = tracker.addM5Bar(lastM5);
  const setup = events.find((e) => e.type === 'SETUP');
  assert.ok(setup, 'expected a SETUP on a fully-aligned bullish MTF stack');
  assert.strictEqual(setup.direction, 'LONG');
  assert.ok(setup.stop < setup.entryPx, 'LONG stop must sit below entry');
  assert.ok(Math.abs((setup.target - setup.entryPx) - TARGET_R * (setup.entryPx - setup.stop)) < 1e-6, 'target must be exactly 2R above entry');
  assert.ok(setup.criteria.h1 && setup.criteria.m30 && setup.criteria.m5Trigger, 'criteria recorded on the setup');
});

// ---------------------------------------------------------------------------
// B: mirror-image SHORT alignment.
// ---------------------------------------------------------------------------
check('SHORT: aligned 1H/30m/5m produces a SETUP, mirror-image of LONG', () => {
  const { tracker, lastM5 } = buildAlignedTracker('TESTSHORT', 'SHORT');
  const events = tracker.addM5Bar(lastM5);
  const setup = events.find((e) => e.type === 'SETUP');
  assert.ok(setup, 'expected a SETUP on a fully-aligned bearish MTF stack');
  assert.strictEqual(setup.direction, 'SHORT');
  assert.ok(setup.stop > setup.entryPx, 'SHORT stop must sit above entry');
  assert.ok(Math.abs((setup.entryPx - setup.target) - TARGET_R * (setup.stop - setup.entryPx)) < 1e-6, 'target must be exactly 2R below entry');
});

// ---------------------------------------------------------------------------
// C: insufficient lookback (thin 5m history) -- must never SETUP even if the
//    higher timeframes look aligned, because the invalidation gate can't clear.
// ---------------------------------------------------------------------------
check('insufficient 5m lookback: no SETUP fires before the invalidation gate can evaluate', () => {
  const h1 = buildTrend(150, ONE_HOUR, 1000, 2);
  const m30 = buildTrend(150, THIRTY_MIN, 1000, 1.5);
  const m5 = buildTrend(50, FIVE_MIN, 1000, 0.5); // far short of the ~226-bar gate/EMA200 threshold
  const tracker = new MtfSymbolTracker('TESTTHIN');
  tracker.seedHistory({ h1, m30, m5: m5.slice(0, m5.length - 1) });
  const events = tracker.addM5Bar(m5[m5.length - 1]);
  assert.ok(!events.some((e) => e.type === 'SETUP'), 'must not fire a SETUP with insufficient 5m lookback');
});

// ---------------------------------------------------------------------------
// D: SL path -- a fired LONG setup, then a crash bar that trades through the
//    stop, must close OUTCOME=SL at exactly -1R.
// ---------------------------------------------------------------------------
check('LONG: SETUP -> crash bar -> OUTCOME SL (-1R)', () => {
  const { tracker, lastM5 } = buildAlignedTracker('TESTSL', 'LONG');
  const setup = tracker.addM5Bar(lastM5).find((e) => e.type === 'SETUP');
  assert.ok(setup && tracker.trade, 'precondition: setup must fire and leave an open trade');

  const crash = {
    timestampMs: lastM5.timestampMs + FIVE_MIN,
    open: setup.entryPx, high: setup.entryPx, low: setup.stop - 1, close: setup.stop - 0.5, volume: 100,
  };
  const ev = tracker.addM5Bar(crash);
  const outcome = ev.find((e) => e.type === 'OUTCOME');
  assert.ok(outcome && outcome.result === 'SL', `expected SL outcome, got ${outcome && outcome.result}`);
  assert.ok(Math.abs(outcome.rMultiple + 1) < 1e-9, `SL outcome should be exactly -1R, got ${outcome.rMultiple}`);
  assert.strictEqual(tracker.trade, null, 'trade must be cleared after a closed outcome (re-entry now allowed)');
});

// ---------------------------------------------------------------------------
// E: TARGET path -- a fired SHORT setup, then a bar trading through the 2R
//    target, must close OUTCOME=TARGET at exactly +2R.
// ---------------------------------------------------------------------------
check('SHORT: SETUP -> rally-through-target bar -> OUTCOME TARGET (+2R)', () => {
  const { tracker, lastM5 } = buildAlignedTracker('TESTTP', 'SHORT');
  const setup = tracker.addM5Bar(lastM5).find((e) => e.type === 'SETUP');
  assert.ok(setup && tracker.trade, 'precondition: setup must fire and leave an open trade');

  const drop = {
    timestampMs: lastM5.timestampMs + FIVE_MIN,
    open: setup.entryPx, high: setup.entryPx + 1, low: setup.target - 1, close: setup.target - 0.5, volume: 100,
  };
  const ev = tracker.addM5Bar(drop);
  const outcome = ev.find((e) => e.type === 'OUTCOME');
  assert.ok(outcome && outcome.result === 'TARGET', `expected TARGET outcome, got ${outcome && outcome.result}`);
  assert.ok(Math.abs(outcome.rMultiple - TARGET_R) < 1e-9, `TARGET outcome should be exactly +${TARGET_R}R, got ${outcome.rMultiple}`);
});

// ---------------------------------------------------------------------------
// F: early-reversal WARNING -- edge-triggered once, fires when the Baseline
//    (Kijun) crosses back through the 200 EMA against an open LONG.
// ---------------------------------------------------------------------------
check('LONG: early-reversal WARNING fires once when Kijun crosses back below the 200 EMA', () => {
  const { tracker, lastM5 } = buildAlignedTracker('TESTWARN', 'LONG');
  const setup = tracker.addM5Bar(lastM5).find((e) => e.type === 'SETUP');
  assert.ok(setup && tracker.trade, 'precondition: setup must fire and leave an open trade');
  tracker.trade.stop = -Infinity; // disable SL so the reversal path can be isolated

  // Feed a sharp down-move so Kijun (26-bar) drops back below the (slow-moving) 200 EMA.
  let ts = lastM5.timestampMs;
  let px = setup.entryPx;
  let warning = null;
  for (let i = 0; i < 40 && !warning; i++) {
    ts += FIVE_MIN;
    px -= 3;
    const bar = { timestampMs: ts, open: px + 3, high: px + 3.2, low: px - 0.2, close: px, volume: 100 };
    const ev = tracker.addM5Bar(bar);
    warning = ev.find((e) => e.type === 'WARNING');
  }
  assert.ok(warning, 'expected a WARNING event once Kijun crosses back below the 200 EMA');
  assert.strictEqual(tracker.trade.warningFired, true, 'warningFired flag should be set on the open trade');
});

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
