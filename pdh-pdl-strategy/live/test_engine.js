'use strict';

/**
 * Offline self-test for the PDH/PDL engine — no network, no DB, no feed.
 * Drives PdhPdlTracker with hand-built synthetic candles and asserts the
 * ARMED -> SETUP -> milestone -> OUTCOME sequence, plus the one-shot filter
 * rejecting a choppy (consolidated) approach. Run: `npm test`.
 */

const assert = require('assert');
const { PdhPdlTracker } = require('./pdh_pdl_engine');

const DAY = '2026-08-04';
const ms = (hh, mm) => Date.parse(`${DAY}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
const bar = (hh, mm, o, h, l, c) => ({ timestampMs: ms(hh, mm), open: o, high: h, low: l, close: c, volume: 1000 });

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n     ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Scenario A: clean LONG — impulsive drop into PDH, hammer, runs to 3R.
// ---------------------------------------------------------------------------
check('LONG: arm -> setup(PIN) -> T1.5R,T2R -> T3R', () => {
  const t = new PdhPdlTracker('TESTLONG');
  t.setLevels(100.0, 95.0); // PDH=100, PDL=95

  // 15m close above PDH at 09:30 -> ARMED LONG
  const armed = t.onNew15mBar(bar(9, 30, 100.2, 101.5, 100.1, 101.0));
  assert.strictEqual(armed.length, 1, 'expected 1 ARMED event');
  assert.strictEqual(armed[0].type, 'ARMED');
  assert.strictEqual(armed[0].direction, 'LONG');

  // impulsive, one-directional fall back toward 100 (none of these touch 100)
  const approach = [
    bar(9, 35, 103.0, 103.2, 102.6, 102.7),
    bar(9, 40, 102.7, 102.8, 102.0, 102.1),
    bar(9, 45, 102.1, 102.2, 101.4, 101.5),
    bar(9, 50, 101.5, 101.6, 100.9, 101.0),
    bar(9, 55, 101.0, 101.1, 100.4, 100.5),
  ];
  for (const b of approach) assert.strictEqual(t.onNew5mBar(b).length, 0, 'no signal during approach');

  // 10:00 hammer touching 100: tiny body, long lower wick, arrives in one shot
  const ev = t.onNew5mBar(bar(10, 0, 100.35, 100.45, 99.9, 100.4));
  const setup = ev.find((e) => e.type === 'SETUP');
  assert.ok(setup, 'expected a SETUP event');
  assert.strictEqual(setup.triggerType, 'PIN');
  assert.ok(setup.effRatio >= 0.55, `efficiency ${setup.effRatio} should clear 0.55`);
  // entry 100.4, sl = 99.9 - 0.10 = 99.80, r = 0.60
  assert.ok(Math.abs(setup.sl - 99.8) < 1e-9, `sl=${setup.sl}`);
  assert.ok(Math.abs(setup.r - 0.6) < 1e-9, `r=${setup.r}`);

  // rally: hit 1.5R (101.3), then 2R (101.6), then 3R (102.2)
  const e1 = t.onNew5mBar(bar(10, 5, 100.4, 101.35, 100.4, 101.3));
  assert.ok(e1.some((e) => e.type === 'MILESTONE' && e.level === 'T1.5R'), 'expected T1.5R');
  const e2 = t.onNew5mBar(bar(10, 10, 101.3, 101.65, 101.2, 101.6));
  assert.ok(e2.some((e) => e.type === 'MILESTONE' && e.level === 'T2R'), 'expected T2R');
  const e3 = t.onNew5mBar(bar(10, 15, 101.6, 102.30, 101.5, 102.25));
  const out = e3.find((e) => e.type === 'OUTCOME');
  assert.ok(out && out.result === 'T3R', 'expected T3R outcome');
  assert.ok(Math.abs(out.rMultiple - 3) < 1e-9, `rMultiple=${out.rMultiple}`);
});

// ---------------------------------------------------------------------------
// Scenario B: SL first — LONG that reverses and stops out at -1R.
// ---------------------------------------------------------------------------
check('LONG: setup -> SL (-1R)', () => {
  const t = new PdhPdlTracker('TESTSL');
  t.setLevels(100.0, 95.0);
  t.onNew15mBar(bar(9, 30, 100.2, 101.5, 100.1, 101.0));
  for (const b of [
    bar(9, 35, 103.0, 103.2, 102.6, 102.7), bar(9, 40, 102.7, 102.8, 102.0, 102.1),
    bar(9, 45, 102.1, 102.2, 101.4, 101.5), bar(9, 50, 101.5, 101.6, 100.9, 101.0),
    bar(9, 55, 101.0, 101.1, 100.4, 100.5),
  ]) t.onNew5mBar(b);
  const setup = t.onNew5mBar(bar(10, 0, 100.35, 100.45, 99.9, 100.4)).find((e) => e.type === 'SETUP');
  assert.ok(setup, 'setup expected');
  const out = t.onNew5mBar(bar(10, 5, 100.4, 100.5, 99.7, 99.75)).find((e) => e.type === 'OUTCOME');
  assert.ok(out && out.result === 'SL', 'expected SL outcome');
  assert.ok(Math.abs(out.rMultiple + 1) < 1e-9, `rMultiple=${out.rMultiple}`);
});

// ---------------------------------------------------------------------------
// Scenario C: one-shot filter REJECTS a choppy/consolidated approach.
// Same hammer, but price grinds sideways into the level (low efficiency) and
// tags the level beforehand -> no PIN setup should fire.
// ---------------------------------------------------------------------------
check('LONG: choppy approach -> pin REJECTED (no setup)', () => {
  const t = new PdhPdlTracker('TESTCHOP');
  t.setLevels(100.0, 95.0);
  t.onNew15mBar(bar(9, 30, 100.2, 101.5, 100.1, 101.0));
  // sideways grind around 100.3–100.6, tagging 100 twice — not a one-shot arrival
  for (const b of [
    bar(9, 35, 100.5, 100.7, 99.99, 100.3), bar(9, 40, 100.3, 100.6, 100.1, 100.5),
    bar(9, 45, 100.5, 100.7, 99.98, 100.4), bar(9, 50, 100.4, 100.6, 100.2, 100.3),
    bar(9, 55, 100.3, 100.5, 100.1, 100.4),
  ]) t.onNew5mBar(b);
  const ev = t.onNew5mBar(bar(10, 0, 100.35, 100.45, 99.9, 100.4));
  assert.ok(!ev.some((e) => e.type === 'SETUP'), 'no SETUP should fire on a consolidated approach');
});

// ---------------------------------------------------------------------------
// Scenario D: window boundary — a 15m break that CLOSES after 11:45 must not arm.
// ---------------------------------------------------------------------------
check('window: 15m break closing at 12:00 (start 11:45) does NOT arm', () => {
  const t = new PdhPdlTracker('TESTWIN');
  t.setLevels(100.0, 95.0);
  const late = t.onNew15mBar(bar(11, 45, 100.2, 101.5, 100.1, 101.0)); // closes 12:00
  assert.strictEqual(late.length, 0, 'should not arm outside the window');
  const edge = t.onNew15mBar(bar(11, 30, 100.2, 101.5, 100.1, 101.0));  // closes 11:45 (last valid)
  assert.strictEqual(edge.length, 1, 'break closing exactly at 11:45 should arm');
});

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
