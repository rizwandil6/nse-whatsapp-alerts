'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ShadowDualFilterTracker } = require('./shadow_dual_filter_tracker');

function b(open, close, high, low, direction, timestampMs) {
  return { open, close, high, low, direction, timestampMs, volume: 0 };
}

function bar5(close, idx) {
  return { close, timestampMs: idx * 5 * 60 * 1000, open: close, high: close, low: close, volume: 0 };
}

// Same fixture darvas_tracker.test.js already relies on: 25 bars rising 100->124
// (EMA9 > EMA20 throughout, aligned for LONG), then a sharp drop for 10 bars
// (EMA9 crosses below EMA20 at index 31/103.0, aligned for SHORT beyond there).
function buildBearishCrossBars() {
  const bars = [];
  for (let i = 0; i < 25; i++) bars.push(bar5(100 + i, i));
  for (let i = 1; i <= 10; i++) bars.push(bar5(124 - i * 3, 24 + i));
  return bars;
}
const UPTREND_TIMESTAMP_MS = 30 * 5 * 60 * 1000;   // aligned for LONG
const DOWNTREND_TIMESTAMP_MS = 34 * 5 * 60 * 1000; // aligned for SHORT

test('processBricks: does NOT enter at the breakout brick when candle-EMA is counter-trend, but enters on a LATER brick once candle-EMA has flipped, as long as price stayed beyond the box', () => {
  const bars5 = buildBearishCrossBars();
  const tr = new ShadowDualFilterTracker('TEST');
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2), // box {top:105,bottom:100} confirms as of index 3
    b(100, 110, 110, 100, 'up', DOWNTREND_TIMESTAMP_MS + 1), // breakout brick -- candle-EMA counter-trend for LONG here
    b(110, 112, 112, 110, 'up', UPTREND_TIMESTAMP_MS + 1),   // later brick, still beyond box.top(105) -- candle-EMA now aligned
  ];
  const events = tr.processBricks(bricks, bars5);
  const entry = events.find((e) => e.type === 'ENTRY');
  assert.ok(entry, `expected a delayed ENTRY, got: ${JSON.stringify(events)}`);
  assert.equal(entry.entry, 112, 'must enter at the LATER brick, not the original breakout');
  assert.equal(entry.breakoutTimestampMs, DOWNTREND_TIMESTAMP_MS + 1, 'still records the original breakout time for reference');
  assert.equal(entry.timestampMs, UPTREND_TIMESTAMP_MS + 1);
});

test('processBricks: pending is discarded (never enters) if price reverts back inside the box before candle-EMA aligns', () => {
  const bars5 = buildBearishCrossBars();
  const tr = new ShadowDualFilterTracker('TEST');
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2), // box {top:105,bottom:100}
    b(100, 110, 110, 100, 'up', DOWNTREND_TIMESTAMP_MS + 1), // breakout, counter-trend -- pending starts
    b(110, 104, 110, 104, 'down', DOWNTREND_TIMESTAMP_MS + 2), // reverts back inside the box (104 < 105)
    b(104, 112, 112, 104, 'up', UPTREND_TIMESTAMP_MS + 1), // even though candle-EMA is aligned now, pending was already discarded
  ];
  const events = tr.processBricks(bricks, bars5);
  assert.equal(events.length, 0, `expected no entry at all, got: ${JSON.stringify(events)}`);
  assert.equal(tr.pending, null);
  assert.equal(tr.position, null);
});

test('processBricks: only one shadow position at a time -- a second breakout is ignored while one is already open', () => {
  const tr = new ShadowDualFilterTracker('TEST');
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2), // box A {top:105,bottom:100}
    b(100, 110, 110, 100, 'up', UPTREND_TIMESTAMP_MS + 1), // breakout A -- enters (no bars5 supplied -> candle filter fails open)
    b(110, 108, 110, 108, 'down', 4), // pulls back, contained
    b(108, 109, 109, 108, 'up', 5),   // contained
    b(109, 107, 109, 107, 'down', 6), // contained x3 -> box B confirms
    b(107, 115, 115, 107, 'up', 7),   // breakout B -- must be ignored, still flat-checking would otherwise take it
  ];
  const events = tr.processBricks(bricks);
  const entries = events.filter((e) => e.type === 'ENTRY');
  assert.equal(entries.length, 1, `expected exactly one ENTRY, got: ${JSON.stringify(entries)}`);
  assert.equal(entries[0].entry, 110);
});

test('processBricks: volume-spike filter still blocks the pending setup even when EMA agrees, same as the real tracker', () => {
  const entryBars = [];
  for (let i = 0; i < 20; i++) entryBars.push({ timestampMs: i * 60000, volume: 100 });
  const tr = new ShadowDualFilterTracker('TEST');
  const spikeTs = 20 * 60000;
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2),
    { ...b(100, 110, 110, 100, 'up', spikeTs), volume: 700 }, // 7x trailing avg -- suppressed
  ];
  const events = tr.processBricks(bricks, [], entryBars);
  assert.equal(events.length, 0, `expected no entry (volume spike), got: ${JSON.stringify(events)}`);
  assert.ok(tr.pending, 'setup should remain pending, not discarded -- price never left the box');
});

test('checkEmaCrossExit and forceEodClose behave the same as the real tracker (reused logic, shadow-tagged)', () => {
  const bars = buildBearishCrossBars();
  const tr = new ShadowDualFilterTracker('TEST');
  tr.position = { direction: 'LONG', entry: 100, entryTimestampMs: bar5(0, 5).timestampMs, breakoutTimestampMs: 0 };
  const e = tr.checkEmaCrossExit(bars);
  assert.ok(e);
  assert.equal(e.action, 'EMA_9_20_CROSS');
  assert.equal(e.exitPrice, 103);
  assert.equal(e.shadow, true);
  assert.equal(tr.position, null);

  const tr2 = new ShadowDualFilterTracker('TEST2');
  tr2.position = { direction: 'SHORT', entry: 50, entryTimestampMs: 0, breakoutTimestampMs: 0 };
  const bricks = [b(50, 45, 50, 45, 'down', 0), b(45, 40, 45, 40, 'down', 1)];
  const eodEvent = tr2.forceEodClose(bricks);
  assert.equal(eodEvent.action, 'EOD_SQUARE_OFF');
  assert.equal(eodEvent.exitPrice, 40);
  assert.equal(eodEvent.shadow, true);
});

test('resetForNewDay clears pending and position state', () => {
  const tr = new ShadowDualFilterTracker('TEST');
  tr.pending = { direction: 'LONG', level: 100, breakoutTimestampMs: 0 };
  tr.position = { direction: 'LONG', entry: 100, entryTimestampMs: 0 };
  tr.processedBrickCount = 5;
  tr.processedBar5Count = 3;
  tr.resetForNewDay();
  assert.equal(tr.pending, null);
  assert.equal(tr.position, null);
  assert.equal(tr.processedBrickCount, 0);
  assert.equal(tr.processedBar5Count, 0);
});
