'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { eventKey } = require('./trade_log');

// --- eventKey (fixed 2026-07-31, real incident: two separate backfill-replay
// duplicates -- 2026-07-28's TRAILING_BOX_STOP-era and 2026-07-31's EMA-cross-
// era -- both re-derived a DIFFERENT price for an already-recorded trade, and
// the old price-inclusive key treated each as a brand-new event instead of a
// duplicate). Price must NOT be part of the key -- brick timestamps alone
// already uniquely identify a specific trade. ---

test('eventKey: two ENTRY events for the same trade with DIFFERENT prices produce the SAME key', () => {
  const original = { type: 'ENTRY', symbol: 'ORIENTELEC', direction: 'SHORT', entry: 173.4, timestampMs: 1785491700000 };
  const replayed = { type: 'ENTRY', symbol: 'ORIENTELEC', direction: 'SHORT', entry: 174.213375, timestampMs: 1785491700000 };
  assert.equal(eventKey(original), eventKey(replayed));
});

test('eventKey: two EXIT events for the same trade with DIFFERENT entry/exit prices produce the SAME key', () => {
  const original = {
    type: 'EXIT', symbol: 'JSWINFRA', direction: 'SHORT', action: 'EOD_SQUARE_OFF',
    entry: 316.7, exitPrice: 312.25, entryTimestampMs: 1785481500000, exitTimestampMs: 1785489300000,
  };
  const replayed = {
    type: 'EXIT', symbol: 'JSWINFRA', direction: 'SHORT', action: 'EOD_SQUARE_OFF',
    entry: 317.554125, exitPrice: 312.4, entryTimestampMs: 1785481500000, exitTimestampMs: 1785489300000,
  };
  assert.equal(eventKey(original), eventKey(replayed));
});

test('eventKey: still discriminates genuinely different trades (different timestamps)', () => {
  const first = { type: 'ENTRY', symbol: 'NHPC', direction: 'LONG', entry: 78.85, timestampMs: 1785490500000 };
  const second = { type: 'ENTRY', symbol: 'NHPC', direction: 'LONG', entry: 78.85, timestampMs: 1785216780000 };
  assert.notEqual(eventKey(first), eventKey(second));
});

test('eventKey: still discriminates different symbols/directions/actions at the same timestamp', () => {
  const long = { type: 'EXIT', symbol: 'TITAGARH', direction: 'LONG', action: 'EMA_9_20_CROSS', entryTimestampMs: 1, exitTimestampMs: 2 };
  const short = { type: 'EXIT', symbol: 'TITAGARH', direction: 'SHORT', action: 'EMA_9_20_CROSS', entryTimestampMs: 1, exitTimestampMs: 2 };
  const eod = { type: 'EXIT', symbol: 'TITAGARH', direction: 'LONG', action: 'EOD_SQUARE_OFF', entryTimestampMs: 1, exitTimestampMs: 2 };
  assert.notEqual(eventKey(long), eventKey(short));
  assert.notEqual(eventKey(long), eventKey(eod));
});
