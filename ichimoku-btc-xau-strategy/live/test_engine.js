'use strict';

/**
 * Offline self-test for the MTF Ichimoku engine -- no network, no DB, no
 * exchange connection. Drives MtfSymbolTracker with synthetic OHLC series
 * per timeframe (clean monotonic trends, which satisfy all the MTF alignment
 * conditions once enough lookback exists) and asserts SETUP -> OUTCOME(SL) /
 * OUTCOME(TARGET) / OUTCOME(WARNING_EXIT), mirroring
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
function buildAlignedTracker(symbol, direction, opts) {
  const sign = direction === 'LONG' ? 1 : -1;
  const h1 = buildTrend(150, ONE_HOUR, 1000, sign * 2);
  const m30 = buildTrend(150, THIRTY_MIN, 1000, sign * 1.5);
  const m5 = buildTrend(260, FIVE_MIN, 1000, sign * 0.5); // >200 for EMA200 + gate lookback

  const tracker = new MtfSymbolTracker(symbol, opts);
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
// F: early reversal exit -- fires when the Baseline (Kijun) crosses back
//    through the 200 EMA against an open LONG. Changed 2026-08-22 from a
//    discretionary WARNING alert to a hard close (OUTCOME result
//    WARNING_EXIT), per the user's request.
// ---------------------------------------------------------------------------
check('LONG: reversal exit closes the trade (WARNING_EXIT) once Kijun crosses back below the 200 EMA', () => {
  const { tracker, lastM5 } = buildAlignedTracker('TESTWARN', 'LONG');
  const setup = tracker.addM5Bar(lastM5).find((e) => e.type === 'SETUP');
  assert.ok(setup && tracker.trade, 'precondition: setup must fire and leave an open trade');
  tracker.trade.stop = -Infinity; // disable SL so the reversal-exit path can be isolated

  // Feed a sharp down-move so Kijun (26-bar) drops back below the (slow-moving) 200 EMA.
  let ts = lastM5.timestampMs;
  let px = setup.entryPx;
  let outcome = null;
  for (let i = 0; i < 40 && !outcome; i++) {
    ts += FIVE_MIN;
    px -= 3;
    const bar = { timestampMs: ts, open: px + 3, high: px + 3.2, low: px - 0.2, close: px, volume: 100 };
    const ev = tracker.addM5Bar(bar);
    outcome = ev.find((e) => e.type === 'OUTCOME');
  }
  assert.ok(outcome, 'expected an OUTCOME once Kijun crosses back below the 200 EMA');
  assert.strictEqual(outcome.result, 'WARNING_EXIT', `expected WARNING_EXIT, got ${outcome && outcome.result}`);
  assert.ok(outcome.kijun != null && outcome.ema200 != null, 'kijun/ema200 context must be attached to the outcome');
  assert.strictEqual(tracker.trade, null, 'trade must be cleared (re-entry now allowed) after a reversal exit');
});

// ---------------------------------------------------------------------------
// G: resume after a restart -- a still-open position (per a DB row) that
//    hasn't hit stop/target yet must reattach with no spurious events, and
//    addM5Bar must NOT re-enter a fresh setup while it's tracked.
// ---------------------------------------------------------------------------
check('resume: reattaches a still-open position from a DB row, no re-entry while tracked', () => {
  const { tracker, lastM5, m5 } = buildAlignedTracker('TESTRESUME', 'LONG');
  const entryBar = m5[m5.length - 2]; // an earlier bar stands in for "the original entry"
  const row = {
    id: 1, direction: 'LONG', entry_ts: new Date(entryBar.timestampMs).toISOString(),
    entry_px: entryBar.close, stop_px: entryBar.close - 1000, target_px: entryBar.close + 1000,
    r_value: 1000, ema200_at_entry: entryBar.close - 50, criteria: { h1: 'x' }, warning_fired: false,
  };
  // seedHistory only kept bars up to (m5.length - 2); re-seed through entryBar's index so
  // resumeTrade's post-entry replay has the bars between entry and "now" to scan (mirrors what
  // seedSymbol's real history pull would contain across a restart).
  tracker.seedHistory({ h1: tracker.h1, m30: tracker.m30, m5: m5.slice(0, m5.length - 1) });
  const events = tracker.resumeTrade(row);
  assert.ok(tracker.trade, 'trade must be reattached (open)');
  assert.strictEqual(tracker.trade.entryPx, entryBar.close);
  assert.strictEqual(events.some((e) => e.type === 'OUTCOME'), false, 'no stop/target was actually hit -- must not report one');

  const reEvents = tracker.addM5Bar(lastM5);
  assert.ok(!reEvents.some((e) => e.type === 'SETUP'), 'must not fire a fresh SETUP while a resumed trade is open');
});

// ---------------------------------------------------------------------------
// H: resume catch-up -- if the stop was already hit by seeded bars between the
//    original entry and "now" (i.e. it resolved while the process was down),
//    resumeTrade must report that OUTCOME immediately instead of losing it.
// ---------------------------------------------------------------------------
check('resume: catches up a stop that was already hit while the process was down', () => {
  const { tracker, lastM5 } = buildAlignedTracker('TESTRESUMESL', 'LONG');
  const entryPx = lastM5.close;
  const stop = entryPx - 5;
  const crash = { timestampMs: lastM5.timestampMs + FIVE_MIN, open: entryPx, high: entryPx, low: stop - 1, close: stop - 0.5, volume: 100 };
  tracker.seedHistory({ h1: tracker.h1, m30: tracker.m30, m5: [...tracker.m5, lastM5, crash] });
  const row = {
    id: 2, direction: 'LONG', entry_ts: new Date(lastM5.timestampMs).toISOString(),
    entry_px: entryPx, stop_px: stop, target_px: entryPx + 1000, r_value: 5,
    ema200_at_entry: entryPx - 50, criteria: {}, warning_fired: false,
  };
  const events = tracker.resumeTrade(row);
  const outcome = events.find((e) => e.type === 'OUTCOME');
  assert.ok(outcome && outcome.result === 'SL', `expected a caught-up SL outcome, got ${outcome && outcome.result}`);
  assert.strictEqual(tracker.trade, null, 'trade must be cleared once the catch-up finds it already closed');
});

// ---------------------------------------------------------------------------
// I: phase-out symbol (entriesEnabled=false) -- must never fire a fresh SETUP
// even on a fully-aligned MTF stack, but a resumed OPEN trade must still be
// tracked to a real outcome. Added 2026-08-23 for the BTCUSDT/XAUUSDT ->
// BTCINR/XAUINR symbol-set switch, where the old symbol's still-open trade
// had to keep running to completion without any new entries on it.
// ---------------------------------------------------------------------------
check('phase-out symbol: never fires a fresh SETUP even when fully aligned', () => {
  const { tracker, lastM5 } = buildAlignedTracker('TESTPHASEOUT', 'LONG', { entriesEnabled: false });
  const events = tracker.addM5Bar(lastM5);
  assert.ok(!events.some((e) => e.type === 'SETUP'), 'entriesEnabled=false must block a fresh SETUP');
  assert.strictEqual(tracker.trade, null, 'no trade should have opened');
});

check('phase-out symbol: a resumed OPEN trade still tracks through to a real outcome', () => {
  const { tracker, lastM5 } = buildAlignedTracker('TESTPHASEOUTRESUME', 'LONG', { entriesEnabled: false });
  const entryPx = lastM5.close;
  const target = entryPx + 5;
  const row = {
    id: 3, direction: 'LONG', entry_ts: new Date(lastM5.timestampMs - FIVE_MIN).toISOString(),
    entry_px: entryPx - 10, stop_px: entryPx - 20, target_px: target, r_value: 10,
    ema200_at_entry: entryPx - 15, criteria: {}, warning_fired: false,
  };
  tracker.resumeTrade(row);
  assert.ok(tracker.trade, 'the resumed trade must still be tracked despite entriesEnabled=false');

  const rally = { timestampMs: lastM5.timestampMs + FIVE_MIN, open: entryPx, high: target + 1, low: entryPx, close: target + 0.5, volume: 100 };
  const events = tracker.addM5Bar(rally);
  const outcome = events.find((e) => e.type === 'OUTCOME');
  assert.ok(outcome && outcome.result === 'TARGET', `expected the phase-out trade to still resolve to TARGET, got ${outcome && outcome.result}`);
  assert.ok(!events.some((e) => e.type === 'SETUP'), 'must not fire a fresh SETUP after the phase-out trade closes');
});

// ---------------------------------------------------------------------------
// K: per-bar DIAGNOSTIC event -- added 2026-08-24 so "why didn't it fire" has a
// real per-bar log trail. Must fire on every entry-evaluated bar (both when a
// SETUP does and doesn't result), carrying the actual criteria booleans.
// ---------------------------------------------------------------------------
check('DIAGNOSTIC event fires on every entry-evaluated bar, with real criteria state', () => {
  const { tracker, lastM5 } = buildAlignedTracker('TESTDIAG', 'LONG');
  const events = tracker.addM5Bar(lastM5);
  const diag = events.find((e) => e.type === 'DIAGNOSTIC');
  assert.ok(diag, 'expected a DIAGNOSTIC event on a fully-evaluated bar');
  assert.strictEqual(diag.lookbackReady, true);
  assert.strictEqual(diag.longOk, true, 'a fully-aligned bullish stack should report longOk=true');
  assert.strictEqual(diag.h1.aboveCloudAndBaseline, true);
  assert.strictEqual(diag.m5.kijunAboveEma, true);

  // Thin-lookback tracker: DIAGNOSTIC must still fire, just flagged not-ready.
  const h1 = buildTrend(150, ONE_HOUR, 1000, 2);
  const m30 = buildTrend(150, THIRTY_MIN, 1000, 1.5);
  const m5 = buildTrend(50, FIVE_MIN, 1000, 0.5);
  const thin = new MtfSymbolTracker('TESTDIAGTHIN');
  thin.seedHistory({ h1, m30, m5: m5.slice(0, m5.length - 1) });
  const thinEvents = thin.addM5Bar(m5[m5.length - 1]);
  const thinDiag = thinEvents.find((e) => e.type === 'DIAGNOSTIC');
  assert.ok(thinDiag, 'expected a DIAGNOSTIC event even with insufficient lookback');
  assert.strictEqual(thinDiag.lookbackReady, false);
});

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
