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

// ---------------------------------------------------------------------------
// Scenario E: min-R filter (pdhpdl-v2). Same TCS pin whose R is only ~0.056% of
// price; with minRPct=0.25 the setup must still fire + track, but alerted=false.
// ---------------------------------------------------------------------------
function drivePinSetup(minRPct) {
  const t = new PdhPdlTracker('TCS', { minRPct });
  t.setLevels(3200.0, 3150.0);
  t.onNew15mBar(bar(9, 30, 3201, 3209, 3200.5, 3208));
  for (const b of [
    bar(9, 35, 3218, 3219, 3215, 3215.5), bar(9, 40, 3215.5, 3216, 3211, 3211.5),
    bar(9, 45, 3211.5, 3212, 3208, 3208.5), bar(9, 50, 3208.5, 3209, 3205, 3205.5),
    bar(9, 55, 3205.5, 3206, 3202, 3202.5), bar(10, 0, 3202.5, 3203, 3201, 3201.5),
  ]) t.onNew5mBar(b);
  return { t, ev: t.onNew5mBar(bar(10, 5, 3200.9, 3201.3, 3199.4, 3201.1)) };
}

check('min-R v2: tiny-R setup fires but alerted=false, still tracks to T3R', () => {
  const { t, ev } = drivePinSetup(0.25);
  const setup = ev.find((e) => e.type === 'SETUP');
  assert.ok(setup, 'setup still fires (logged + tracked)');
  assert.ok(setup.rPct < 0.25, `rPct ${setup.rPct} should be under the 0.25% gate`);
  assert.strictEqual(setup.alerted, false, 'small-R setup must be alerted=false');
  // outcome tracking is unaffected by the alert gate
  t.onNew5mBar(bar(10, 10, 3201.1, 3204.0, 3201.0, 3203.8));
  t.onNew5mBar(bar(10, 15, 3203.8, 3205.5, 3203.5, 3205.2));
  const out = t.onNew5mBar(bar(10, 20, 3205.2, 3208.5, 3205.0, 3208.2)).find((e) => e.type === 'OUTCOME');
  assert.ok(out && out.result === 'T3R', 'filtered setup still tracks its outcome');
});

check('v1 default: same setup is alerted=true with rPct populated', () => {
  const { ev } = drivePinSetup(0); // no filter
  const setup = ev.find((e) => e.type === 'SETUP');
  assert.strictEqual(setup.alerted, true, 'no filter → alerted=true');
  assert.ok(setup.rPct > 0, 'rPct should be populated');
});

// ===========================================================================
//  v3 variant (author's "Trading With Sidhant" v2 spec)
// ===========================================================================

// Arms LONG at PDH=100, then an impulsive one-shot drop back toward 100 with
// every low staying above the line (so leftLevel is set and no return-leg tag).
function v3Long(extraOpts) {
  const t = new PdhPdlTracker('V3L', Object.assign({ variant: 'v3', gapFilter: false }, extraOpts || {}));
  t.setLevels(100.0, 95.0, 99.6);
  t.onNew15mBar(bar(9, 30, 100.2, 101.5, 100.1, 101.0));
  for (const b of [
    bar(9, 35, 103.0, 103.3, 102.5, 102.7), bar(9, 40, 102.7, 102.9, 102.0, 102.1),
    bar(9, 45, 102.1, 102.3, 101.4, 101.5), bar(9, 50, 101.5, 101.7, 100.9, 101.0),
    bar(9, 55, 101.0, 101.2, 100.4, 100.5), bar(10, 0, 100.5, 100.7, 100.15, 100.3),
  ]) t.onNew5mBar(b);
  return t;
}

check('v3: strict directional PIN accepted (green hammer, one-shot)', () => {
  const t = v3Long();
  const ev = t.onNew5mBar(bar(10, 5, 100.1, 100.5, 98.8, 100.4)); // green hammer touching 100
  const s = ev.find((e) => e.type === 'SETUP');
  assert.ok(s, 'expected a v3 SETUP');
  assert.strictEqual(s.triggerType, 'PIN');
  assert.strictEqual(s.signalSeq, 1);
  assert.ok(s.rangeAtr > 0, 'rangeAtr should be populated');
  assert.ok(Math.abs(s.sl - Math.round((98.8 - 0.10) / 0.05) * 0.05) < 1e-9, `sl rounded: ${s.sl}`);
});

check('v3: RED "hammer" rejected (not directional, no engulf) -> no setup', () => {
  const t = v3Long();
  const ev = t.onNew5mBar(bar(10, 5, 100.5, 100.55, 98.8, 100.0)); // red body, long lower wick
  assert.ok(!ev.some((e) => e.type === 'SETUP'), 'a red hammer must not fire a v3 long');
});

check('v3: proper ENGULFING accepted (bigger body, closes beyond, full swallow)', () => {
  const t = v3Long();
  t.onNew5mBar(bar(10, 5, 100.5, 100.6, 99.8, 99.9));      // real bearish bar at the line
  const ev = t.onNew5mBar(bar(10, 10, 99.8, 101.0, 99.7, 100.8)); // bullish engulf, closes > prev high
  const s = ev.find((e) => e.type === 'SETUP');
  assert.ok(s && s.triggerType === 'ENGULF', 'expected a v3 ENGULF setup');
});

check('v3: weak engulf rejected (does not close beyond prior high) -> no setup', () => {
  const t = v3Long();
  t.onNew5mBar(bar(10, 5, 100.5, 100.6, 99.8, 99.9));
  const ev = t.onNew5mBar(bar(10, 10, 99.8, 100.55, 99.7, 100.5)); // close 100.5 < prev high 100.6
  assert.ok(!ev.some((e) => e.type === 'SETUP'), 'engulf that fails close-beyond must not fire');
});

check('v3: gap day stands down (GAP_SKIP, no arm)', () => {
  const t = new PdhPdlTracker('GAP', { variant: 'v3' }); // gapFilter default ON
  t.setLevels(100.0, 95.0, 99.0);
  const g = t.onNew5mBar(bar(9, 15, 99.8, 100.0, 99.6, 99.9)); // open 99.8 vs pdc 99 = 0.81% gap
  assert.ok(g.some((e) => e.type === 'GAP_SKIP'), 'expected GAP_SKIP');
  const armed = t.onNew15mBar(bar(9, 30, 100.2, 101.5, 100.1, 101.0));
  assert.strictEqual(armed.length, 0, 'must not arm on a gap day');
});

check('v3: leave-and-return required (immediate retest, never left) -> no setup', () => {
  const t = new PdhPdlTracker('LR', { variant: 'v3', gapFilter: false });
  t.setLevels(100.0, 95.0, 99.6);
  t.onNew15mBar(bar(9, 30, 100.2, 101.5, 100.1, 101.0));
  // price hugs the line — every low <= 100, so it never fully leaves
  for (const b of [
    bar(9, 35, 100.1, 100.2, 99.6, 99.9), bar(9, 40, 99.9, 100.1, 99.7, 100.0),
    bar(9, 45, 100.0, 100.15, 99.6, 99.95), bar(9, 50, 99.95, 100.1, 99.7, 100.0),
    bar(9, 55, 100.0, 100.1, 99.6, 99.9),
  ]) t.onNew5mBar(b);
  const ev = t.onNew5mBar(bar(10, 0, 100.1, 100.5, 98.8, 100.4)); // perfect hammer, but never left
  assert.ok(!ev.some((e) => e.type === 'SETUP'), 'no entry until price has left and returned');
});

check('v3: 2 trades/day then deactivate after 2 SLs', () => {
  const t = v3Long();
  // trade 1: pin, then stop out
  const s1 = t.onNew5mBar(bar(10, 5, 100.1, 100.5, 98.8, 100.4)).find((e) => e.type === 'SETUP');
  assert.ok(s1 && s1.signalSeq === 1, 'trade 1 setup');
  const o1 = t.onNew5mBar(bar(10, 10, 100.4, 100.5, 98.5, 98.6)).find((e) => e.type === 'OUTCOME');
  assert.ok(o1 && o1.result === 'SL', 'trade 1 stops out');
  // trade 2: an engulf re-entry (exempt from one-shot), then stop out
  t.onNew5mBar(bar(10, 15, 100.6, 100.7, 99.8, 99.9));            // real bearish bar at line
  const s2 = t.onNew5mBar(bar(10, 20, 99.8, 101.0, 99.7, 100.9)).find((e) => e.type === 'SETUP');
  assert.ok(s2 && s2.signalSeq === 2, 'trade 2 setup (signalSeq 2)');
  const o2 = t.onNew5mBar(bar(10, 25, 100.9, 101.0, 99.4, 99.5)).find((e) => e.type === 'OUTCOME');
  assert.ok(o2 && o2.result === 'SL', 'trade 2 stops out');
  // trade 3 must NOT fire — deactivated after 2 SLs
  t.onNew5mBar(bar(10, 30, 100.6, 100.7, 99.8, 99.9));
  const ev3 = t.onNew5mBar(bar(10, 35, 99.8, 101.0, 99.7, 100.9));
  assert.ok(!ev3.some((e) => e.type === 'SETUP'), 'no 3rd trade after 2 stop-losses');
});

check('v3: SL moves to cost after 2R -> reversal exits BE (0R)', () => {
  const t = v3Long();
  const s = t.onNew5mBar(bar(10, 5, 100.1, 100.5, 98.8, 100.4)).find((e) => e.type === 'SETUP');
  assert.ok(s, 'setup');
  // entry 100.4, r=1.70 -> 2R target = 103.80. hit it, then reverse to entry.
  t.onNew5mBar(bar(10, 10, 100.4, 104.0, 100.3, 103.9)); // tags 2R (and beyond t3? t3=105.5, no)
  const o = t.onNew5mBar(bar(10, 15, 103.9, 104.0, 100.3, 100.4)).find((e) => e.type === 'OUTCOME');
  assert.ok(o && o.result === 'BE', `after 2R a reversal to cost exits BE, got ${o && o.result}`);
  assert.ok(Math.abs(o.rMultiple) < 1e-9, `BE is 0R, got ${o && o.rMultiple}`);
});

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
