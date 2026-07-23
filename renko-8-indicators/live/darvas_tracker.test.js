'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DarvasLiveTracker } = require('./darvas_tracker');

function tick(ltp, lttMs) {
  return { ltp, lttMs };
}

test('checkTickStop: no-op with no open position', () => {
  const tr = new DarvasLiveTracker('TEST');
  assert.equal(tr.checkTickStop(tick(100, 1000)), null);
});

test('checkTickStop: skips a tick at/before entryTimestampMs', () => {
  const tr = new DarvasLiveTracker('TEST');
  tr.position = { direction: 'LONG', entry: 100, stop: 98, entryTimestampMs: 5000 };
  assert.equal(tr.checkTickStop(tick(90, 5000)), null); // at entry time -- below stop, must NOT fire
  assert.equal(tr.checkTickStop(tick(90, 4000)), null); // before entry time
  assert.ok(tr.position, 'position must still be open');
});

test('checkTickStop: fires on LONG hard-stop touch', () => {
  const tr = new DarvasLiveTracker('TEST');
  tr.position = { direction: 'LONG', entry: 100, stop: 98, entryTimestampMs: 5000 };
  const e = tr.checkTickStop(tick(97.5, 6000));
  assert.equal(e.type, 'EXIT');
  assert.equal(e.action, 'TICK_STOP_LOSS');
  assert.equal(e.exitPrice, 98); // exits at the STOP price, not the touching tick's ltp
  assert.equal(e.direction, 'LONG');
  assert.ok(e.pnlPct < 0);
  assert.equal(tr.position, null);
});

test('checkTickStop: fires on SHORT hard-stop touch', () => {
  const tr = new DarvasLiveTracker('TEST');
  tr.position = { direction: 'SHORT', entry: 100, stop: 102, entryTimestampMs: 5000 };
  const e = tr.checkTickStop(tick(102.5, 6000));
  assert.equal(e.action, 'TICK_STOP_LOSS');
  assert.equal(e.exitPrice, 102);
  assert.ok(e.pnlPct < 0);
  assert.equal(tr.position, null);
});

test('checkTickStop: does not fire while price stays inside stop/trailStop', () => {
  const tr = new DarvasLiveTracker('TEST');
  tr.position = { direction: 'LONG', entry: 100, stop: 98, entryTimestampMs: 5000 };
  assert.equal(tr.checkTickStop(tick(99, 6000)), null);
  assert.equal(tr.checkTickStop(tick(105, 7000)), null);
  assert.ok(tr.position);
});

test('checkTickStop: uses the tighter trailing stop once set, LONG', () => {
  const tr = new DarvasLiveTracker('TEST');
  tr.position = { direction: 'LONG', entry: 100, stop: 98, trailStop: 99.5, entryTimestampMs: 5000 };
  // Price above the hard stop (98) but below the trailing stop (99.5) -- must still fire.
  assert.equal(tr.checkTickStop(tick(99.4, 6000)) === null, false);
});

test('checkTickStop: uses the tighter trailing stop once set, SHORT', () => {
  const tr = new DarvasLiveTracker('TEST');
  tr.position = { direction: 'SHORT', entry: 100, stop: 102, trailStop: 100.5, entryTimestampMs: 5000 };
  assert.equal(tr.checkTickStop(tick(100.6, 6000)) === null, false);
});

test('checkTickStop: real TRITURBINE 2026-07-23 case fires near the true touch instead of hours later', () => {
  // Real recorded values from data/darvasbox-paper-trade-log: entry 617.10 @
  // 10:00:00 IST, stop 615.27. Real price touched 615.20 at 10:15 IST but the
  // brick-based check didn't register the exit until 12:30 IST.
  const tr = new DarvasLiveTracker('TRITURBINE');
  const entryTimestampMs = Date.parse('2026-07-23T10:00:00+05:30');
  const touchTimestampMs = Date.parse('2026-07-23T10:15:00+05:30');
  tr.position = { direction: 'LONG', entry: 617.1044, stop: 615.2696, entryTimestampMs };

  // Ticks leading up to and through the real touch.
  assert.equal(tr.checkTickStop(tick(618.4, entryTimestampMs + 60000)), null);
  assert.equal(tr.checkTickStop(tick(616.0, entryTimestampMs + 5 * 60000)), null);
  const exitEvent = tr.checkTickStop(tick(615.2, touchTimestampMs));
  assert.ok(exitEvent, 'expected an exit at the real 10:15 touch');
  assert.equal(exitEvent.action, 'TICK_STOP_LOSS');
  assert.equal(exitEvent.exitPrice, 615.2696);
  assert.equal(exitEvent.exitTimestampMs, touchTimestampMs);
  assert.ok(exitEvent.pnlPct < 0 && exitEvent.pnlPct > -1); // ~-0.30%, matching the real recorded trade
});
