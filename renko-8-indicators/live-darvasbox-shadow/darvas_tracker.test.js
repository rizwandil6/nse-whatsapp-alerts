'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DarvasLiveTracker } = require('./darvas_tracker');

function b(open, close, high, low, direction, timestampMs) {
  return { open, close, high, low, direction, timestampMs, volume: 0 };
}

// --- processBricks: entries only (2026-07-28 -- all stop-loss/exit logic moved to checkEmaCrossExit) ---

test('processBricks ENTRY: uses live LTP as the real entry, keeps theoreticalEntry for reference', () => {
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2), // 3rd contained brick -- box {top:105, bottom:100} confirms as of index 3
    b(100, 110, 110, 100, 'up', 3), // close 110 > box.top(105) -> LONG entry, theoretical price 110
  ];
  const tr = new DarvasLiveTracker('TEST', () => 108); // live LTP = 108, different from theoretical 110
  const events = tr.processBricks(bricks);
  const entryEvent = events.find((e) => e.type === 'ENTRY');
  assert.ok(entryEvent, 'expected an ENTRY event');
  assert.equal(entryEvent.direction, 'LONG');
  assert.equal(entryEvent.entry, 108); // real (LTP), not the theoretical brick close
  assert.equal(entryEvent.theoreticalEntry, 110);
  assert.equal(entryEvent.livePriceAvailable, true);
  assert.equal(entryEvent.stop, undefined); // no stop-loss field at all anymore
  assert.equal(tr.position.entry, 108);
  assert.equal(tr.position.stop, undefined);
});

test('processBricks ENTRY: falls back to the theoretical brick close when no live price is available', () => {
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2),
    b(100, 110, 110, 100, 'up', 3),
  ];
  const tr = new DarvasLiveTracker('TEST', () => null); // no live price available
  const events = tr.processBricks(bricks);
  const entryEvent = events.find((e) => e.type === 'ENTRY');
  assert.equal(entryEvent.entry, 110); // falls back to theoretical
  assert.equal(entryEvent.theoreticalEntry, 110);
  assert.equal(entryEvent.livePriceAvailable, false);
});

test('processBricks: never produces an EXIT, even on what used to be a TRAILING_BOX_STOP setup', () => {
  // Same brick sequence that used to trigger TRAILING_BOX_STOP under the old design --
  // confirms that exit logic is gone from processBricks entirely (getExit is a no-op).
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2),
    b(100, 110, 110, 100, 'up', 3),
    b(110, 108, 110, 108, 'down', 4),
    b(108, 109, 109, 108, 'up', 5),
    b(109, 95, 109, 95, 'down', 6),
  ];
  const tr = new DarvasLiveTracker('TEST', () => null);
  const events = tr.processBricks(bricks);
  assert.equal(events.find((e) => e.type === 'EXIT'), undefined, `expected no exit, got: ${JSON.stringify(events)}`);
  assert.ok(tr.position, 'position should still be open -- only checkEmaCrossExit or forceEodClose can close it now');
});

// --- checkEmaCrossExit: the only exit mechanism (2026-07-28) ---

function bar5(close, idx) {
  return { close, timestampMs: idx * 5 * 60 * 1000, open: close, high: close, low: close, volume: 0 };
}

// 25 bars rising 100->124 (both EMAs trend up, EMA9 stays above EMA20 throughout the
// uptrend), then a sharp drop for 10 bars -- EMA9 (faster) crosses below EMA20 at
// index 31 (close 103.0). Verified analytically before writing this test.
function buildBearishCrossBars() {
  const bars = [];
  for (let i = 0; i < 25; i++) bars.push(bar5(100 + i, i));
  for (let i = 1; i <= 10; i++) bars.push(bar5(124 - i * 3, 24 + i));
  return bars;
}
// Mirror image: 25 bars falling 200->176, then a sharp rise for 10 bars -- EMA9
// crosses above EMA20 at the same relative index (31), close = 197.0.
function buildBullishCrossBars() {
  const bars = [];
  for (let i = 0; i < 25; i++) bars.push(bar5(200 - i, i));
  for (let i = 1; i <= 10; i++) bars.push(bar5(176 + i * 3, 24 + i));
  return bars;
}

test('checkEmaCrossExit: no-op with no open position', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  assert.equal(tr.checkEmaCrossExit(buildBearishCrossBars()), null);
});

// --- processBricks entry trend-alignment filter (2026-07-29) ---

function bricksForEntry(direction, breakoutTimestampMs) {
  const c = direction === 'LONG' ? [110, 110, 100] : [90, 100, 90]; // [close, high, low] of the breakout brick
  return [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2), // box {top:105,bottom:100} confirms as of index 3
    b(100, c[0], c[1], c[2], direction === 'LONG' ? 'up' : 'down', breakoutTimestampMs),
  ];
}

// In buildBearishCrossBars(): index 30 (t=9,000,000ms) has EMA9(113.806) > EMA20(113.656)
// -- an uptrend, aligned for a LONG. Index 34 (t=10,200,000ms) has EMA9(104.282) <
// EMA20(108.532) -- a downtrend, aligned for a SHORT. Verified analytically (same
// fixture the checkEmaCrossExit tests above already rely on).
const UPTREND_TIMESTAMP_MS = 30 * 5 * 60 * 1000;
const DOWNTREND_TIMESTAMP_MS = 34 * 5 * 60 * 1000;

test('processBricks: LONG breakout is taken when EMA9 > EMA20 at that moment (trend-aligned)', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  const bricks = bricksForEntry('LONG', UPTREND_TIMESTAMP_MS + 1);
  const events = tr.processBricks(bricks, buildBearishCrossBars());
  assert.ok(events.find((e) => e.type === 'ENTRY'), `expected an ENTRY, got: ${JSON.stringify(events)}`);
  assert.ok(tr.position);
});

test('processBricks: LONG breakout is suppressed when EMA9 < EMA20 at that moment (counter-trend) -- confirmed live on SUZLON 2026-07-29', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  const bricks = bricksForEntry('LONG', DOWNTREND_TIMESTAMP_MS + 1);
  const events = tr.processBricks(bricks, buildBearishCrossBars());
  assert.equal(events.length, 0, `expected no events, got: ${JSON.stringify(events)}`);
  assert.equal(tr.position, null, 'no position should have been opened');
});

test('processBricks: SHORT breakout is taken when EMA9 < EMA20 at that moment (trend-aligned)', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  const bricks = bricksForEntry('SHORT', DOWNTREND_TIMESTAMP_MS + 1);
  const events = tr.processBricks(bricks, buildBearishCrossBars());
  assert.ok(events.find((e) => e.type === 'ENTRY'), `expected an ENTRY, got: ${JSON.stringify(events)}`);
  assert.ok(tr.position);
});

test('processBricks: SHORT breakout is suppressed when EMA9 > EMA20 at that moment (counter-trend)', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  const bricks = bricksForEntry('SHORT', UPTREND_TIMESTAMP_MS + 1);
  const events = tr.processBricks(bricks, buildBearishCrossBars());
  assert.equal(events.length, 0, `expected no events, got: ${JSON.stringify(events)}`);
  assert.equal(tr.position, null);
});

test('processBricks: fails OPEN (allows the entry) when bars5 is not supplied at all', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  const bricks = bricksForEntry('LONG', DOWNTREND_TIMESTAMP_MS + 1); // would be counter-trend if EMA data existed
  const events = tr.processBricks(bricks); // no bars5 argument
  assert.ok(events.find((e) => e.type === 'ENTRY'), 'missing EMA data must not block the entry');
});

test('processBricks: fails OPEN when the breakout predates all available bars5 (EMA not seeded yet)', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  const bricks = bricksForEntry('LONG', -1); // before bars5[0]'s timestamp entirely
  const events = tr.processBricks(bricks, buildBearishCrossBars());
  assert.ok(events.find((e) => e.type === 'ENTRY'), 'no EMA state yet must not block the entry');
});

test('checkEmaCrossExit: LONG exits on the bearish 9/20 cross, priced at the bar close (no live price)', () => {
  const bars = buildBearishCrossBars();
  const tr = new DarvasLiveTracker('TEST', () => null);
  tr.position = { direction: 'LONG', entry: 100, entryTimestampMs: bar5(0, 5).timestampMs }; // entered well before the cross
  const e = tr.checkEmaCrossExit(bars);
  assert.ok(e, 'expected an EMA cross exit');
  assert.equal(e.type, 'EXIT');
  assert.equal(e.action, 'EMA_9_20_CROSS');
  assert.equal(e.direction, 'LONG');
  assert.equal(e.exitPrice, 103); // bar index 31's close, the first bearish cross
  assert.equal(e.theoreticalExit, 103);
  assert.equal(e.livePriceAvailable, false);
  assert.equal(tr.position, null);
});

test('checkEmaCrossExit: SHORT exits on the bullish 9/20 cross', () => {
  const bars = buildBullishCrossBars();
  const tr = new DarvasLiveTracker('TEST', () => null);
  tr.position = { direction: 'SHORT', entry: 200, entryTimestampMs: bar5(0, 5).timestampMs };
  const e = tr.checkEmaCrossExit(bars);
  assert.ok(e, 'expected an EMA cross exit');
  assert.equal(e.action, 'EMA_9_20_CROSS');
  assert.equal(e.direction, 'SHORT');
  assert.equal(e.exitPrice, 197); // mirror of the bearish case
  assert.ok(e.pnlPct > 0); // SHORT profits when price falls, which it did before the reversal
});

test('checkEmaCrossExit: SHORT does NOT exit on a bearish cross (wrong direction) -- LONG does', () => {
  const bars = buildBearishCrossBars();
  const trShort = new DarvasLiveTracker('TEST', () => null);
  trShort.position = { direction: 'SHORT', entry: 100, entryTimestampMs: bar5(0, 5).timestampMs };
  const e = trShort.checkEmaCrossExit(bars);
  assert.equal(e, null, 'a SHORT should not exit on a bearish cross -- that favors the SHORT');
  assert.ok(trShort.position, 'SHORT position should still be open');
});

test('checkEmaCrossExit: skips bars at/before entryTimestampMs (entered AFTER the cross bar has no exit)', () => {
  const bars = buildBearishCrossBars();
  const tr = new DarvasLiveTracker('TEST', () => null);
  // Enter at the exact cross bar's own timestamp -- must not fire off its own entry bar.
  tr.position = { direction: 'LONG', entry: 103, entryTimestampMs: bars[31].timestampMs };
  const e = tr.checkEmaCrossExit(bars);
  assert.equal(e, null);
  assert.ok(tr.position);
});

test('checkEmaCrossExit: prices the exit at live LTP when available, keeps the bar close as theoreticalExit', () => {
  const bars = buildBearishCrossBars();
  const tr = new DarvasLiveTracker('TEST', () => 102.5); // live LTP differs from the bar's own close (103)
  tr.position = { direction: 'LONG', entry: 100, entryTimestampMs: bar5(0, 5).timestampMs };
  const e = tr.checkEmaCrossExit(bars);
  assert.equal(e.exitPrice, 102.5);
  assert.equal(e.theoreticalExit, 103);
  assert.equal(e.livePriceAvailable, true);
});

test('checkEmaCrossExit: does not fire while EMAs never cross', () => {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push(bar5(100 + i * 0.1, i)); // gentle, monotonic uptrend, no cross
  const tr = new DarvasLiveTracker('TEST', () => null);
  tr.position = { direction: 'LONG', entry: 100, entryTimestampMs: bar5(0, 2).timestampMs };
  assert.equal(tr.checkEmaCrossExit(bars), null);
  assert.ok(tr.position);
});

// --- forceEodClose: unchanged, still brick-driven ---

// --- processBricks entry volume-spike filter (2026-07-29) ---

function bar1m(volume, idxMinutes) {
  return { timestampMs: idxMinutes * 60 * 1000, volume, open: 0, high: 0, low: 0, close: 0 };
}

// 20 same-day 1-min bars (minutes 0..19) at a steady volume of 100 each -- trailing
// average is exactly 100. The breakout brick lands at minute 20.
function buildSteadyVolumeBars1m() {
  const bars = [];
  for (let i = 0; i < 20; i++) bars.push(bar1m(100, i));
  return bars;
}
const ENTRY_MINUTE_MS = 20 * 60 * 1000;

test('processBricks: entry taken when volume is a MODEST multiple of trailing average (below 6x threshold)', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  const bricks = bricksForEntry('LONG', ENTRY_MINUTE_MS);
  bricks[3].volume = 300; // 3x the trailing 100 average -- under VOLUME_SPIKE_THRESHOLD
  const events = tr.processBricks(bricks, [], buildSteadyVolumeBars1m());
  assert.ok(events.find((e) => e.type === 'ENTRY'), `expected an ENTRY, got: ${JSON.stringify(events)}`);
  assert.ok(tr.position);
});

test('processBricks: entry suppressed when volume is >= 6x trailing average (extreme spike)', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  const bricks = bricksForEntry('LONG', ENTRY_MINUTE_MS);
  bricks[3].volume = 700; // 7x the trailing 100 average -- over VOLUME_SPIKE_THRESHOLD
  const events = tr.processBricks(bricks, [], buildSteadyVolumeBars1m());
  assert.equal(events.length, 0, `expected no events, got: ${JSON.stringify(events)}`);
  assert.equal(tr.position, null, 'no position should have been opened');
});

test('processBricks: fails OPEN (allows the entry) when bars1m is not supplied at all', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  const bricks = bricksForEntry('LONG', ENTRY_MINUTE_MS);
  bricks[3].volume = 100000; // would be an enormous spike if bars1m existed
  const events = tr.processBricks(bricks, []); // no bars1m argument
  assert.ok(events.find((e) => e.type === 'ENTRY'), 'missing volume data must not block the entry');
});

test('processBricks: fails OPEN when fewer than 5 same-day trailing bars are available', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  const bricks = bricksForEntry('LONG', 3 * 60 * 1000); // only 3 prior bars exist (minutes 0-2)
  bricks[3].volume = 100000;
  const thinBars1m = [bar1m(100, 0), bar1m(100, 1), bar1m(100, 2)];
  const events = tr.processBricks(bricks, [], thinBars1m);
  assert.ok(events.find((e) => e.type === 'ENTRY'), 'insufficient trailing history must not block the entry');
});

test('forceEodClose: closes an open position at the last brick close', () => {
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2),
    b(100, 110, 110, 100, 'up', 3),
  ];
  const tr = new DarvasLiveTracker('TEST', () => null);
  tr.processBricks(bricks);
  assert.ok(tr.position, 'expected an open LONG position from the breakout');
  const e = tr.forceEodClose(bricks);
  assert.equal(e.action, 'EOD_SQUARE_OFF');
  assert.equal(e.exitPrice, 110);
  assert.equal(tr.position, null);
});

// --- Persistence (added 2026-07-31, real incident: a mid-day restart re-derived
// an already-open position's entry from theoreticalEntry instead of the real
// LTP-confirmed entry, producing a wrongly-priced duplicate EOD close). ---

test('toJSON/restorePosition: round-trips an open position, dropping entryIdx', () => {
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2),
    b(100, 110, 110, 100, 'up', 3),
  ];
  const tr = new DarvasLiveTracker('TEST', () => 108);
  tr.processBricks(bricks);
  assert.equal(tr.position.entryIdx, 3);

  const json = tr.toJSON();
  const restored = new DarvasLiveTracker('TEST', () => null);
  restored.restorePosition(json);

  assert.equal(restored.position.entry, 108);
  assert.equal(restored.position.direction, 'LONG');
  assert.equal(restored.position.entryTimestampMs, 3);
  assert.equal(restored.position.entryIdx, null, 'entryIdx must be dropped -- meaningless against a freshly rebuilt bricks array');
});

test('restorePosition: no-op when json/position is missing (fresh symbol, nothing to restore)', () => {
  const tr = new DarvasLiveTracker('TEST', () => null);
  tr.restorePosition(null);
  assert.equal(tr.position, null);
  tr.restorePosition({ position: null });
  assert.equal(tr.position, null);
});

test('forceEodClose: after restorePosition, prices using pos.entryTimestampMs directly -- NOT bricks[stale entryIdx]', () => {
  // Simulates a restart: the restored position's entryIdx (dropped to null)
  // no longer corresponds to anything in a freshly rebuilt bricks array of a
  // completely different length/content than whatever existed pre-restart.
  const staleJson = { position: { direction: 'LONG', entry: 173.4, entryIdx: 7, entryTimestampMs: 555 } };
  const tr = new DarvasLiveTracker('ORIENTELEC', () => null);
  tr.restorePosition(staleJson);

  const freshBricks = [
    b(100, 100, 105, 100, 'up', 900),
    b(100, 173.4, 175, 100, 'up', 901), // unrelated fresh brick series, only 2 long -- would throw/misindex at old entryIdx=7
  ];
  const e = tr.forceEodClose(freshBricks);
  assert.equal(e.entryTimestampMs, 555); // pos.entryTimestampMs, not bricks[7] (which doesn't exist)
  assert.equal(e.barsHeld, null); // entryIdx is null post-restore -- cosmetic field, honestly unknown rather than wrong
  assert.equal(e.entry, 173.4);
  assert.equal(e.exitPrice, 173.4);
  assert.equal(e.pnlPct, 0);
});
