'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveDarvasTracker } = require('./live_tracker');
const { RiskManager } = require('./risk_manager');

function b(open, close, high, low, direction, timestampMs) {
  return { open, close, high, low, direction, timestampMs, volume: 0 };
}
function bar5(close, idx, high, low) {
  return { close, timestampMs: idx * 5 * 60 * 1000, open: close, high: high != null ? high : close, low: low != null ? low : close, volume: 0 };
}

/** Mock OrderClient -- records calls, returns scripted results. */
function mockOrderClient({ placeOrderResults, waitForFillResults }) {
  let placeCalls = 0, fillCalls = 0;
  const calls = [];
  return {
    calls,
    async placeOrder(instrumentKey, qty, transactionType) {
      calls.push({ fn: 'placeOrder', instrumentKey, qty, transactionType });
      const result = placeOrderResults[Math.min(placeCalls, placeOrderResults.length - 1)];
      placeCalls++;
      if (result instanceof Error) throw result;
      return result;
    },
    async waitForFill(orderId) {
      calls.push({ fn: 'waitForFill', orderId });
      const result = waitForFillResults[Math.min(fillCalls, waitForFillResults.length - 1)];
      fillCalls++;
      return result;
    },
  };
}

const ENTRY_BRICKS = [
  b(100, 100, 105, 100, 'up', 0),
  b(100, 100, 105, 100, 'down', 1),
  b(100, 100, 105, 100, 'up', 2), // box {top:105,bottom:100} confirms as of index 3
  b(100, 110, 110, 100, 'up', 3), // LONG breakout
];

test('entry: places a real BUY order and tracks the confirmed fill price/qty, not the theoretical brick close', async () => {
  const oc = mockOrderClient({
    placeOrderResults: ['ORDER1'],
    waitForFillResults: [{ status: 'complete', avgPrice: 111.25, filledQty: 23 }],
  });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('CONCOR', 'NSE_EQ|X', 23, oc, rm);

  const events = await tr.processBricks(ENTRY_BRICKS);
  const entry = events.find((e) => e.type === 'ENTRY');
  assert.ok(entry, `expected an ENTRY event, got: ${JSON.stringify(events)}`);
  assert.equal(entry.direction, 'LONG');
  assert.equal(entry.entry, 111.25); // real fill price, not the theoretical 110
  assert.equal(entry.qty, 23);
  assert.equal(oc.calls[0].transactionType, 'BUY');
  assert.equal(tr.position.entry, 111.25);
  assert.equal(tr.position.qty, 23);
  assert.ok(tr.position.catastrophicStop < 111.25); // LONG stop sits below entry
});

test('entry: SHORT signal places a SELL order', async () => {
  const bricks = [
    b(100, 100, 105, 100, 'up', 0),
    b(100, 100, 105, 100, 'down', 1),
    b(100, 100, 105, 100, 'up', 2),
    b(100, 90, 100, 90, 'down', 3), // close 90 < box.bottom(100) -> SHORT
  ];
  const oc = mockOrderClient({ placeOrderResults: ['ORDER1'], waitForFillResults: [{ status: 'complete', avgPrice: 89.5, filledQty: 10 }] });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('TEST', 'NSE_EQ|X', 10, oc, rm);
  const events = await tr.processBricks(bricks);
  const entry = events.find((e) => e.type === 'ENTRY');
  assert.equal(entry.direction, 'SHORT');
  assert.equal(oc.calls[0].transactionType, 'SELL');
  assert.ok(tr.position.catastrophicStop > 89.5); // SHORT stop sits above entry
});

test('entry: order placement throwing does NOT create a position', async () => {
  const oc = mockOrderClient({ placeOrderResults: [new Error('insufficient margin')], waitForFillResults: [] });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('CONCOR', 'NSE_EQ|X', 23, oc, rm);
  const events = await tr.processBricks(ENTRY_BRICKS);
  assert.equal(tr.position, null);
  assert.ok(events.find((e) => e.type === 'ORDER_ERROR'));
});

test('entry: an unconfirmed/rejected fill does NOT create a position', async () => {
  const oc = mockOrderClient({ placeOrderResults: ['ORDER1'], waitForFillResults: [{ status: 'rejected' }] });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('CONCOR', 'NSE_EQ|X', 23, oc, rm);
  const events = await tr.processBricks(ENTRY_BRICKS);
  assert.equal(tr.position, null);
  const evt = events.find((e) => e.type === 'ORDER_UNCONFIRMED');
  assert.ok(evt);
  assert.equal(evt.status, 'rejected');
});

test('entry: suppressed entirely (no order placed) when the risk manager circuit breaker has tripped', async () => {
  const oc = mockOrderClient({ placeOrderResults: ['ORDER1'], waitForFillResults: [{ status: 'complete', avgPrice: 111, filledQty: 23 }] });
  const rm = new RiskManager(1000);
  rm.recordRealizedPnl(-1500); // trips the breaker
  const tr = new LiveDarvasTracker('CONCOR', 'NSE_EQ|X', 23, oc, rm);
  const events = await tr.processBricks(ENTRY_BRICKS);
  assert.equal(tr.position, null);
  assert.equal(oc.calls.length, 0, 'no order should have been placed at all');
  assert.equal(events.length, 0);
});

test('entry: does not re-check for a new signal while already in a position', async () => {
  const oc = mockOrderClient({ placeOrderResults: ['ORDER1'], waitForFillResults: [{ status: 'complete', avgPrice: 111, filledQty: 23 }] });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('CONCOR', 'NSE_EQ|X', 23, oc, rm);
  await tr.processBricks(ENTRY_BRICKS);
  assert.equal(oc.calls.length, 2); // placeOrder + waitForFill, exactly once
  // Feed the SAME bricks again (simulating another poll) -- must not re-enter.
  await tr.processBricks(ENTRY_BRICKS);
  assert.equal(oc.calls.length, 2, 'no additional order calls while a position is open');
});

test('EMA cross exit: places a real closing order and computes P&L from the confirmed fill price', async () => {
  const oc = mockOrderClient({
    placeOrderResults: ['ENTRY_ORDER', 'EXIT_ORDER'],
    waitForFillResults: [{ status: 'complete', avgPrice: 100, filledQty: 10 }, { status: 'complete', avgPrice: 103, filledQty: 10 }],
  });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('TEST', 'NSE_EQ|X', 10, oc, rm);
  await tr.processBricks(ENTRY_BRICKS); // enters LONG @100 (mocked fill)

  // 25 bars rising, then a sharp drop -- bearish cross at index 31 (close 103), same fixture math as darvas_tracker.test.js
  const bars = [];
  for (let i = 0; i < 25; i++) bars.push(bar5(100 + i, i));
  for (let i = 1; i <= 10; i++) bars.push(bar5(124 - i * 3, 24 + i));

  const exitEvent = await tr.checkEmaCrossExit(bars);
  assert.ok(exitEvent, 'expected an exit event');
  assert.equal(exitEvent.type, 'EXIT');
  assert.equal(exitEvent.action, 'EMA_9_20_CROSS');
  assert.equal(exitEvent.exitPrice, 103);
  assert.equal(exitEvent.pnlRs, 30); // (103-100)*10, real fill prices
  assert.equal(tr.position, null);
  assert.equal(rm.realizedPnlRs, 30);
  assert.equal(oc.calls[2].transactionType, 'SELL'); // closing a LONG
});

test('catastrophic stop: fires on a real-time bar low touch, independent of the EMA state', async () => {
  const oc = mockOrderClient({
    placeOrderResults: ['ENTRY_ORDER', 'EXIT_ORDER'],
    waitForFillResults: [{ status: 'complete', avgPrice: 100, filledQty: 10 }, { status: 'complete', avgPrice: 97, filledQty: 10 }],
  });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('TEST', 'NSE_EQ|X', 10, oc, rm, { catastrophicStopPct: 0.03 });
  await tr.processBricks(ENTRY_BRICKS); // enters LONG @100, catastrophicStop = 97

  const bars1min = [
    { timestampMs: 5 * 60 * 1000 - 1000, low: 99, high: 101 }, // at/before entry, must not fire
    { timestampMs: 10 * 60 * 1000, low: 96.5, high: 100.5 }, // touches 97 -- fires
  ];
  const exitEvent = await tr.checkCatastrophicStop(bars1min);
  assert.ok(exitEvent, 'expected the catastrophic stop to fire');
  assert.equal(exitEvent.action, 'CATASTROPHIC_STOP');
  assert.equal(exitEvent.pnlRs, -30); // (97-100)*10
  assert.equal(tr.position, null);
});

test('exit order unconfirmed: position stays OPEN (not cleared) with exitAttemptPending set', async () => {
  const oc = mockOrderClient({
    placeOrderResults: ['ENTRY_ORDER', 'EXIT_ORDER'],
    waitForFillResults: [{ status: 'complete', avgPrice: 100, filledQty: 10 }, null], // exit never confirms
  });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('TEST', 'NSE_EQ|X', 10, oc, rm);
  await tr.processBricks(ENTRY_BRICKS);

  const bars = [];
  for (let i = 0; i < 25; i++) bars.push(bar5(100 + i, i));
  for (let i = 1; i <= 10; i++) bars.push(bar5(124 - i * 3, 24 + i));
  const exitEvent = await tr.checkEmaCrossExit(bars);

  assert.equal(exitEvent.type, 'ORDER_UNCONFIRMED');
  assert.ok(tr.position, 'position must NOT be cleared on an unconfirmed exit');
  assert.equal(tr.position.exitAttemptPending, true);
  assert.equal(rm.realizedPnlRs, 0, 'no P&L should be recorded for an unconfirmed exit');
});

test('exit order placement throwing: position stays OPEN with exitAttemptPending set', async () => {
  const oc = mockOrderClient({
    placeOrderResults: ['ENTRY_ORDER', new Error('network error')],
    waitForFillResults: [{ status: 'complete', avgPrice: 100, filledQty: 10 }],
  });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('TEST', 'NSE_EQ|X', 10, oc, rm);
  await tr.processBricks(ENTRY_BRICKS);

  const bars = [];
  for (let i = 0; i < 25; i++) bars.push(bar5(100 + i, i));
  for (let i = 1; i <= 10; i++) bars.push(bar5(124 - i * 3, 24 + i));
  const exitEvent = await tr.checkEmaCrossExit(bars);

  assert.equal(exitEvent.type, 'ORDER_ERROR');
  assert.ok(tr.position);
  assert.equal(tr.position.exitAttemptPending, true);
});

test('once exitAttemptPending is set, no further exit checks re-attempt the close automatically', async () => {
  const oc = mockOrderClient({
    placeOrderResults: ['ENTRY_ORDER', new Error('network error')],
    waitForFillResults: [{ status: 'complete', avgPrice: 100, filledQty: 10 }],
  });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('TEST', 'NSE_EQ|X', 10, oc, rm);
  await tr.processBricks(ENTRY_BRICKS);

  const bars = [];
  for (let i = 0; i < 25; i++) bars.push(bar5(100 + i, i));
  for (let i = 1; i <= 10; i++) bars.push(bar5(124 - i * 3, 24 + i));
  await tr.checkEmaCrossExit(bars); // sets exitAttemptPending
  const callCountAfterFirstAttempt = oc.calls.length;

  const again = await tr.checkEmaCrossExit(bars.concat([bar5(50, 35)]));
  assert.equal(again, null);
  assert.equal(oc.calls.length, callCountAfterFirstAttempt, 'must not silently retry the close');
});

test('forceEodClose: closes an open position', async () => {
  const oc = mockOrderClient({
    placeOrderResults: ['ENTRY_ORDER', 'EXIT_ORDER'],
    waitForFillResults: [{ status: 'complete', avgPrice: 100, filledQty: 10 }, { status: 'complete', avgPrice: 101, filledQty: 10 }],
  });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('TEST', 'NSE_EQ|X', 10, oc, rm);
  await tr.processBricks(ENTRY_BRICKS);
  const exitEvent = await tr.forceEodClose();
  assert.equal(exitEvent.action, 'EOD_SQUARE_OFF');
  assert.equal(tr.position, null);
});

test('forceCircuitBreakerSquareOff: closes an open position regardless of EMA/catastrophic state', async () => {
  const oc = mockOrderClient({
    placeOrderResults: ['ENTRY_ORDER', 'EXIT_ORDER'],
    waitForFillResults: [{ status: 'complete', avgPrice: 100, filledQty: 10 }, { status: 'complete', avgPrice: 95, filledQty: 10 }],
  });
  const rm = new RiskManager(50000);
  const tr = new LiveDarvasTracker('TEST', 'NSE_EQ|X', 10, oc, rm);
  await tr.processBricks(ENTRY_BRICKS);
  const exitEvent = await tr.forceCircuitBreakerSquareOff();
  assert.equal(exitEvent.action, 'CIRCUIT_BREAKER_SQUARE_OFF');
  assert.equal(tr.position, null);
  assert.equal(rm.realizedPnlRs, -50);
});
