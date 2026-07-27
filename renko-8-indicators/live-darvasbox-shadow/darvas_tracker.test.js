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

// --- New for the 0.25%-brick / flat-1%-stop / LTP-confirmed shadow trade (2026-07-27) ---

function b(open, close, high, low, direction, timestampMs) {
  return { open, close, high, low, direction, timestampMs, volume: 0 };
}

test('processBricks ENTRY: uses live LTP as the real entry, flat stop off the REAL entry, keeps theoreticalEntry for reference', () => {
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2), // 3rd contained brick -- box {top:105, bottom:100} confirms as of index 3
    b(100, 110, 110, 100, 'up', 3), // close 110 > box.top(105) -> LONG entry, theoretical price 110
  ];
  const tr = new DarvasLiveTracker('TEST', 0.01, () => 108); // live LTP = 108, different from theoretical 110
  const events = tr.processBricks(bricks);
  const entryEvent = events.find((e) => e.type === 'ENTRY');
  assert.ok(entryEvent, 'expected an ENTRY event');
  assert.equal(entryEvent.direction, 'LONG');
  assert.equal(entryEvent.entry, 108); // real (LTP), not the theoretical brick close
  assert.equal(entryEvent.theoreticalEntry, 110);
  assert.equal(entryEvent.livePriceAvailable, true);
  assert.equal(entryEvent.stop, 108 * 0.99); // flat 1% off the REAL entry, not off 110
  assert.equal(tr.position.entry, 108);
  assert.equal(tr.position.stop, 108 * 0.99);
});

test('processBricks ENTRY: falls back to the theoretical brick close when no live price is available', () => {
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2),
    b(100, 110, 110, 100, 'up', 3),
  ];
  const tr = new DarvasLiveTracker('TEST', 0.01, () => null); // no live price available
  const events = tr.processBricks(bricks);
  const entryEvent = events.find((e) => e.type === 'ENTRY');
  assert.equal(entryEvent.entry, 110); // falls back to theoretical
  assert.equal(entryEvent.theoreticalEntry, 110);
  assert.equal(entryEvent.livePriceAvailable, false);
  assert.equal(entryEvent.stop, 110 * 0.99);
});

test('processBricks EXIT via getExit (TRAILING_BOX_STOP): also priced at live LTP, not the theoretical brick close', () => {
  // Confirm a box, enter LONG, then confirm a SECOND box below the entry so the trailing stop
  // (box.bottom) is breached by a later brick's close -- triggers getExit's TRAILING_BOX_STOP.
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2),   // box #1 {top:105,bottom:100} confirms as of index 3
    b(100, 110, 110, 100, 'up', 3),   // breaks out above 105 -> LONG entry (index 3), breakout also seeds a NEW forming box from this brick (top:110,bottom:100... )
    b(110, 108, 110, 108, 'down', 4), // contained within the new forming range -> count 2
    b(108, 109, 109, 108, 'up', 5),   // contained -> count 3, box #2 confirms as of index 6
    b(109, 95, 109, 95, 'down', 6),   // close 95 < box #2 bottom -- but more importantly, for LONG getExit checks close < pos.trailStop (box.bottom of box #2, since a NEW box confirmed while in a LONG). Theoretical exit price = 95.
  ];
  // stopPct deliberately large (50%) so the flat hard stop sits far below every brick in this
  // test -- isolates the trailing-box-stop path (getExit) from the separate stopHit check,
  // which is pre-existing/unchanged logic already covered by the checkTickStop tests above.
  const tr = new DarvasLiveTracker('TEST', 0.5, () => 96); // live LTP available at exit time too
  const events = tr.processBricks(bricks);
  const exitEvent = events.find((e) => e.type === 'EXIT' && e.action === 'TRAILING_BOX_STOP');
  assert.ok(exitEvent, `expected a TRAILING_BOX_STOP exit, got: ${JSON.stringify(events)}`);
  assert.equal(exitEvent.exitPrice, 96); // real (LTP), not the theoretical brick close (95)
  assert.equal(exitEvent.theoreticalExit, 95);
  assert.equal(exitEvent.livePriceAvailable, true);
});
