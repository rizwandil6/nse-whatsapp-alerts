'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, Action } = require('./tradeRules');
const { simulateTrade } = require('./simulate');

const PARAMS = { targetPct: 2.0, stopLossPct: 1.5, trailPct: 1.0, timeExitMinutes: 45 };

// ── decide() — mirrors TradeRulesTest.java cases 1:1 for cross-language parity ──

test('decide: holds when nothing triggered', () => {
  assert.equal(decide(PARAMS, 0.5, 0.5, false, 5).action, Action.HOLD);
});

test('decide: time exit wins even if in profit', () => {
  assert.equal(decide(PARAMS, 5.0, 5.0, false, 45).action, Action.TIME_EXIT);
});

test('decide: hard stop triggers at threshold', () => {
  assert.equal(decide(PARAMS, -1.5, 0.2, false, 10).action, Action.HARD_STOP);
});

test('decide: partial exit triggers at target and only once', () => {
  assert.equal(decide(PARAMS, 2.0, 2.0, false, 10).action, Action.PARTIAL_EXIT);
  assert.equal(decide(PARAMS, 2.0, 2.0, true, 11).action, Action.HOLD);
});

test('decide: trailing stop only arms after partial exit', () => {
  assert.equal(decide(PARAMS, 1.9, 3.0, false, 12).action, Action.HOLD);
  assert.equal(decide(PARAMS, 1.9, 3.0, true, 12).action, Action.TRAIL_STOP);
});

// ── simulateTrade() — synthetic candle sequences ────────────────────────────

function candle(minuteOffset, entryTimeMs, o, h, l, c) {
  return { timestampMs: entryTimeMs + minuteOffset * 60000, open: o, high: h, low: l, close: c };
}

test('simulateTrade: hard stop fires on the candle that breaches -1.5%', () => {
  const entryTimeMs = 0;
  const entryPrice = 100;
  const candles = [
    candle(1, entryTimeMs, 100, 100.5, 99.8, 100.2),  // -0.2% low, no trigger
    candle(2, entryTimeMs, 100.2, 100.3, 98.0, 98.5), // low -2% -> hard stop
  ];
  const result = simulateTrade(entryPrice, entryTimeMs, candles, PARAMS);
  assert.equal(result.final.action, Action.HARD_STOP);
  assert.equal(result.partial, null);
  assert.ok(result.final.gainPct <= -1.5);
  assert.equal(result.pnlPctOfCapital, result.final.gainPct);
});

test('simulateTrade: partial exit at target, then trailing stop on remainder', () => {
  const entryTimeMs = 0;
  const entryPrice = 100;
  const candles = [
    candle(1, entryTimeMs, 100, 103, 99.9, 102.5),   // high +3% -> partial exit at +3%
    candle(2, entryTimeMs, 102.5, 102.6, 101.9, 102), // low +1.9% -> trail trigger = 3-1=2%, 1.9<=2 -> TRAIL_STOP
  ];
  const result = simulateTrade(entryPrice, entryTimeMs, candles, PARAMS);
  assert.equal(result.partial.action, Action.PARTIAL_EXIT);
  assert.ok(Math.abs(result.partial.gainPct - 3.0) < 1e-9);
  assert.equal(result.final.action, Action.TRAIL_STOP);
  assert.ok(Math.abs(result.final.gainPct - 1.9) < 1e-9);
  // pnl = 0.5*3.0 + 0.5*1.9 = 2.45
  assert.ok(Math.abs(result.pnlPctOfCapital - 2.45) < 1e-9);
});

test('simulateTrade: time exit fires once age reaches timeExitMinutes regardless of price', () => {
  const entryTimeMs = 0;
  const entryPrice = 100;
  const candles = [];
  for (let m = 1; m <= 46; m++) {
    candles.push(candle(m, entryTimeMs, 100, 100.3, 99.8, 100.1)); // flat, never triggers stop/target
  }
  const result = simulateTrade(entryPrice, entryTimeMs, candles, PARAMS);
  assert.equal(result.final.action, Action.TIME_EXIT);
  assert.equal(result.partial, null);
});

test('simulateTrade: hard stop takes priority over target within the same candle', () => {
  // A single wild candle whose low breaches stop-loss AND whose high clears target.
  // Per the documented conservative tie-break, hard stop (checked via low, step 2)
  // wins over partial exit (checked via high, step 3) within the same candle.
  const entryTimeMs = 0;
  const entryPrice = 100;
  const candles = [candle(1, entryTimeMs, 100, 103, 98, 100.5)];
  const result = simulateTrade(entryPrice, entryTimeMs, candles, PARAMS);
  assert.equal(result.final.action, Action.HARD_STOP);
  assert.equal(result.partial, null);
});

test('simulateTrade: reports DATA_EXHAUSTED when candles run out with no exit rule fired', () => {
  const entryTimeMs = 0;
  const entryPrice = 100;
  const candles = [candle(1, entryTimeMs, 100, 100.3, 99.9, 100.1)];
  const result = simulateTrade(entryPrice, entryTimeMs, candles, PARAMS);
  assert.equal(result.final.action, 'DATA_EXHAUSTED');
});
