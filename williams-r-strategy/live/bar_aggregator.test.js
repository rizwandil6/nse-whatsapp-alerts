'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateTo5Min, aggregateTo5MinMultiDay, MARKET_OPEN_MIN } = require('./bar_aggregator');

// 2026-07-27 is a Monday; times are IST. Helper builds a 1-min candle at a given IST date+HH:MM.
function candle(dateStr, hh, mm, close) {
  const utcMs = Date.parse(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
  return { timestampMs: utcMs, open: close, high: close, low: close, close, volume: 100 };
}

test('aggregateTo5Min: single day, buckets 5 one-min candles into one 5-min bar', () => {
  const candles = [
    candle('2026-07-27', 9, 15, 100),
    candle('2026-07-27', 9, 16, 101),
    candle('2026-07-27', 9, 17, 99),
    candle('2026-07-27', 9, 18, 102),
    candle('2026-07-27', 9, 19, 100.5),
  ];
  const bars5 = aggregateTo5Min(candles);
  assert.equal(bars5.length, 1);
  assert.equal(bars5[0].open, 100);
  assert.equal(bars5[0].high, 102);
  assert.equal(bars5[0].low, 99);
  assert.equal(bars5[0].close, 100.5);
});

test('aggregateTo5Min: colliding buckets across two different days silently merge (the bug aggregateTo5MinMultiDay exists to avoid)', () => {
  const candles = [
    candle('2026-07-27', 9, 15, 100),
    candle('2026-07-28', 9, 15, 500), // same time-of-day, different date
  ];
  const bars5 = aggregateTo5Min(candles);
  assert.equal(bars5.length, 1, 'both days collapsed into ONE bucket -- demonstrates why multi-day input must not use this function directly');
});

test('aggregateTo5MinMultiDay: keeps two different days as separate bars, in chronological order', () => {
  const candles = [
    candle('2026-07-28', 9, 15, 500),
    candle('2026-07-28', 9, 16, 501),
    candle('2026-07-27', 9, 15, 100), // out of order on purpose -- function must sort by date
    candle('2026-07-27', 9, 16, 101),
  ];
  const bars5 = aggregateTo5MinMultiDay(candles);
  assert.equal(bars5.length, 2, 'one bar per day, not merged');
  assert.equal(bars5[0].close, 101); // 2026-07-27 comes first chronologically
  assert.equal(bars5[1].close, 501); // 2026-07-28 second
});

test('aggregateTo5MinMultiDay: matches aggregateTo5Min exactly for genuinely single-day input', () => {
  const candles = [
    candle('2026-07-27', 9, 15, 100),
    candle('2026-07-27', 9, 20, 105),
    candle('2026-07-27', 9, 21, 106),
  ];
  const single = aggregateTo5Min(candles);
  const multi = aggregateTo5MinMultiDay(candles);
  assert.deepEqual(multi, single);
});

test('aggregateTo5MinMultiDay: three days concatenate into a continuous series usable for warm-up', () => {
  const candles = [];
  for (const [date, base] of [['2026-07-27', 100], ['2026-07-28', 200], ['2026-07-29', 300]]) {
    for (let m = 0; m < 25; m++) {
      const hh = 9 + Math.floor((15 + m) / 60);
      const mm = (15 + m) % 60;
      candles.push(candle(date, hh, mm, base + m));
    }
  }
  const bars5 = aggregateTo5MinMultiDay(candles);
  // 25 one-min candles/day -> 5 five-min bars/day x 3 days = 15 bars, strictly increasing timestamps
  assert.equal(bars5.length, 15);
  for (let i = 1; i < bars5.length; i++) assert.ok(bars5[i].timestampMs > bars5[i - 1].timestampMs);
});
