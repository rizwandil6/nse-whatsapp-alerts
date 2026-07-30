'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WilliamsRLiveTracker, williamsR, PERIOD, OVERSOLD, OVERBOUGHT, CONFIRM_N } = require('./williams_r_tracker');

// Every bar keeps high=110/low=90 fixed -- as long as at least one bar in the
// trailing PERIOD-bar window still has these extremes (true throughout these
// short tests, since the 14-bar warm-up establishes them and none of the
// handful of bars added afterward exceeds them), the rolling high/low used by
// %R stays exactly 110/90, making %R = (110-close)/20 * -100 an exact,
// hand-checkable formula for every bar in these tests.
function bar(open, close, idx) {
  return { open, high: 110, low: 90, close, timestampMs: idx * 5 * 60 * 1000, volume: 0 };
}

function warmup(n, close) {
  const bars = [];
  for (let i = 0; i < n; i++) bars.push(bar(close, close, i));
  return bars;
}

test('module constants match the one combo backtested and confirmed with the user', () => {
  assert.equal(PERIOD, 14);
  assert.equal(OVERSOLD, -90);
  assert.equal(OVERBOUGHT, -10);
  assert.equal(CONFIRM_N, 2);
});

test('williamsR: exact formula check against the fixed hh=110/ll=90 range used throughout this file', () => {
  const bars = warmup(PERIOD, 100);
  const h = bars.map((b) => b.high), l = bars.map((b) => b.low), c = bars.map((b) => b.close);
  const r = williamsR(h, l, c, PERIOD);
  // close=100 -> (110-100)/20*-100 = -50
  assert.equal(r[PERIOD - 1], -50);
  assert.equal(r[0], null); // warm-up -- not enough bars yet
});

test('LONG entry via confirm_n=2 upward-tick streak (never a single bullish bar -- open=close throughout to rule that path out)', () => {
  const bars = warmup(PERIOD, 100); // establishes hh=110/ll=90, %R=-50
  bars.push(bar(93, 93, PERIOD));      // %R=-85
  bars.push(bar(91, 91, PERIOD + 1));  // %R=-95 -- crosses below oversold(-90) -> longWatch=true
  bars.push(bar(91.5, 91.5, PERIOD + 2)); // %R=-92.5, still <-90, uptick from -95 -> streak=1
  bars.push(bar(91.8, 91.8, PERIOD + 3)); // %R=-91, still <-90, uptick from -92.5 -> streak=2 -> CONFIRMED, pendingEntry
  bars.push(bar(94, 96, PERIOD + 4));     // next bar -- position should open at THIS bar's open (94)

  const tr = new WilliamsRLiveTracker('TEST', () => null);
  const events = tr.processBars(bars);
  const entry = events.find((e) => e.type === 'ENTRY');
  assert.ok(entry, `expected an ENTRY event, got: ${JSON.stringify(events)}`);
  assert.equal(entry.direction, 'LONG');
  assert.equal(entry.entry, 94); // next bar's open, not the confirming bar's own price
  assert.equal(entry.theoreticalEntry, 94);
  assert.equal(entry.livePriceAvailable, false);
  assert.equal(tr.position.entry, 94);
});

test('LONG entry via a single bullish bar (close>open, higher low than prior bar) -- confirms immediately, no need to wait for confirm_n', () => {
  const bars = warmup(PERIOD, 100);
  bars.push(bar(93, 93, PERIOD));                        // %R=-85, low=90 (from bar())
  bars.push(bar(91, 91, PERIOD + 1));                    // %R=-95 -- crosses below oversold -> longWatch=true. low=90 (unchanged, keeps the rolling low fixed at 90)
  bars.push({ ...bar(91, 91.8, PERIOD + 2), low: 90.5 }); // %R=(110-91.8)/20*-100=-91 (still <-90, lands in the confirm-check branch, not "back to neutral") -- close(91.8)>open(91) AND low(90.5)>prior bar's low(90) -> bullish confirm -> pendingEntry immediately, even though %R only ticked from -95 to -91 (not yet 2 upticks). low stays >=90 throughout so the rolling low used by %R is unaffected.
  bars.push(bar(96, 97, PERIOD + 3));                     // next bar -- entry at this bar's open (96)

  const tr = new WilliamsRLiveTracker('TEST', () => null);
  const events = tr.processBars(bars);
  const entry = events.find((e) => e.type === 'ENTRY');
  assert.ok(entry, `expected an ENTRY event, got: ${JSON.stringify(events)}`);
  assert.equal(entry.direction, 'LONG');
  assert.equal(entry.entry, 96);
});

test('SHORT entry mirrors LONG exactly at the overbought boundary', () => {
  const bars = warmup(PERIOD, 100);
  bars.push(bar(107, 107, PERIOD));       // %R=(110-107)/20*-100=-15
  bars.push(bar(109, 109, PERIOD + 1));   // %R=-5 -- crosses above overbought(-10) -> shortWatch=true
  bars.push(bar(108.5, 108.5, PERIOD + 2)); // %R=-7.5, still >-10, downtick from -5 -> streak=1
  bars.push(bar(108.2, 108.2, PERIOD + 3)); // %R=-9, still >-10, downtick from -7.5 -> streak=2 -> CONFIRMED
  bars.push(bar(106, 104, PERIOD + 4));     // next bar -- entry at this bar's open (106)

  const tr = new WilliamsRLiveTracker('TEST', () => null);
  const events = tr.processBars(bars);
  const entry = events.find((e) => e.type === 'ENTRY');
  assert.ok(entry, `expected an ENTRY event, got: ${JSON.stringify(events)}`);
  assert.equal(entry.direction, 'SHORT');
  assert.equal(entry.entry, 106);
});

test('LONG exit fires on %R crossing above overbought (-10), priced at the signal bar\'s own close (exit_on_close semantics)', () => {
  const bars = warmup(PERIOD, 100);
  bars.push(bar(93, 93, PERIOD));
  bars.push(bar(91, 91, PERIOD + 1));
  bars.push(bar(91.5, 91.5, PERIOD + 2));
  bars.push(bar(91.8, 91.8, PERIOD + 3)); // confirms LONG
  bars.push(bar(94, 96, PERIOD + 4));     // entry at open=94

  const tr = new WilliamsRLiveTracker('TEST', () => null);
  tr.processBars(bars);
  assert.ok(tr.position, 'expected an open LONG position');

  // Now drive %R up above overbought(-10): close near 109 -> %R=-5
  const moreBars = [...bars,
    bar(100, 100, PERIOD + 5),
    bar(105, 109, PERIOD + 6), // %R=(110-109)/20*-100=-5 -- crosses above -10 -> R_EXIT, priced at this bar's close (109)
  ];
  const events2 = tr.processBars(moreBars);
  const exit = events2.find((e) => e.type === 'EXIT');
  assert.ok(exit, `expected an EXIT event, got: ${JSON.stringify(events2)}`);
  assert.equal(exit.exitPrice, 109);
  assert.equal(exit.action, 'R_EXIT');
  assert.ok(exit.pnlPct > 0, 'entry 94 -> exit 109 should be a winning LONG');
  assert.equal(tr.position, null);
});

test('no stop-loss of any kind -- a large adverse move that never crosses the opposite threshold keeps the position open', () => {
  const bars = warmup(PERIOD, 100);
  bars.push(bar(93, 93, PERIOD));
  bars.push(bar(91, 91, PERIOD + 1));
  bars.push(bar(91.5, 91.5, PERIOD + 2));
  bars.push(bar(91.8, 91.8, PERIOD + 3));
  bars.push(bar(94, 96, PERIOD + 4)); // LONG entry at 94

  const tr = new WilliamsRLiveTracker('TEST', () => null);
  tr.processBars(bars);
  assert.ok(tr.position);

  // Price crashes hard but %R stays deep oversold (well below -10) -- must NOT exit.
  const crashed = [...bars, bar(90, 90, PERIOD + 5)]; // %R=(110-90)/20*-100=-100, nowhere near overbought
  const events = tr.processBars(crashed);
  assert.equal(events.find((e) => e.type === 'EXIT'), undefined, 'no stop-loss exists -- must not exit on adverse price alone');
  assert.ok(tr.position, 'position should still be open');
});

test('entry/exit use live LTP for the newest bar, falling back to the theoretical price for anything older (replay)', () => {
  const bars = warmup(PERIOD, 100);
  bars.push(bar(93, 93, PERIOD));
  bars.push(bar(91, 91, PERIOD + 1));
  bars.push(bar(91.5, 91.5, PERIOD + 2));
  bars.push(bar(91.8, 91.8, PERIOD + 3));
  bars.push(bar(94, 96, PERIOD + 4)); // entry bar -- LATEST bar in this call, so live price applies

  const tr = new WilliamsRLiveTracker('TEST', () => 95.5); // live LTP differs from theoretical open (94)
  const events = tr.processBars(bars);
  const entry = events.find((e) => e.type === 'ENTRY');
  assert.equal(entry.entry, 95.5); // live LTP used
  assert.equal(entry.theoreticalEntry, 94); // theoretical kept for reference
  assert.equal(entry.livePriceAvailable, true);
});

test('replaying multiple bars in one call only uses live price for the LAST bar, not intermediate ones', () => {
  const bars = warmup(PERIOD, 100);
  bars.push(bar(93, 93, PERIOD));
  bars.push(bar(91, 91, PERIOD + 1));
  bars.push(bar(91.5, 91.5, PERIOD + 2));
  bars.push(bar(91.8, 91.8, PERIOD + 3)); // confirms
  bars.push(bar(94, 96, PERIOD + 4));     // entry bar -- NOT the last bar in this call
  bars.push(bar(97, 98, PERIOD + 5));     // now the last bar

  const tr = new WilliamsRLiveTracker('TEST', () => 999); // would be an absurd entry price if wrongly applied
  const events = tr.processBars(bars);
  const entry = events.find((e) => e.type === 'ENTRY');
  assert.equal(entry.entry, 94); // theoretical, since the entry bar wasn't the newest bar in this call
  assert.equal(entry.livePriceAvailable, false);
});

test('persistence round-trip: toJSON/fromJSON preserves an open position and resumes processing only bars after lastProcessedTimestampMs', () => {
  const bars = warmup(PERIOD, 100);
  bars.push(bar(93, 93, PERIOD));
  bars.push(bar(91, 91, PERIOD + 1));
  bars.push(bar(91.5, 91.5, PERIOD + 2));
  bars.push(bar(91.8, 91.8, PERIOD + 3));
  bars.push(bar(94, 96, PERIOD + 4)); // entry at 94

  const tr = new WilliamsRLiveTracker('TEST', () => null);
  tr.processBars(bars);
  assert.ok(tr.position);

  const json = tr.toJSON();
  assert.equal(json.position.entry, 94);
  assert.equal(json.lastProcessedTimestampMs, bars[bars.length - 1].timestampMs);

  const restored = WilliamsRLiveTracker.fromJSON('TEST', () => null, json);
  assert.equal(restored.position.entry, 94);

  // Re-processing the SAME bars again (simulating a restart re-fetching the same lookback) must not re-emit the ENTRY.
  const events = restored.processBars(bars);
  assert.equal(events.length, 0, 'no bars are newer than lastProcessedTimestampMs -- nothing new to process');

  // A genuinely new bar (exit trigger) after restore -- must still fire independent of the fresh fetch's array length.
  const withNewBar = [...bars, bar(100, 100, PERIOD + 5), bar(105, 109, PERIOD + 6)];
  const events2 = restored.processBars(withNewBar);
  assert.ok(events2.find((e) => e.type === 'EXIT'), 'restored tracker should still detect the exit on new bars');
});

test('fromJSON with no persisted state (first-ever run) starts flat, matching a brand-new tracker', () => {
  const tr = WilliamsRLiveTracker.fromJSON('TEST', () => null, undefined);
  assert.equal(tr.position, null);
  assert.equal(tr.longWatch, false);
  assert.equal(tr.shortWatch, false);
  assert.equal(tr.lastProcessedTimestampMs, null);
});

test('watch state resets if %R climbs back above oversold before confirming (no phantom entry)', () => {
  const bars = warmup(PERIOD, 100);
  bars.push(bar(91, 91, PERIOD));     // %R=-95 -- crosses below oversold -> longWatch=true
  bars.push(bar(95, 95, PERIOD + 1)); // %R=(110-95)/20*-100=-75 -- back above oversold(-90) -> longWatch cancelled
  bars.push(bar(100, 100, PERIOD + 2));

  const tr = new WilliamsRLiveTracker('TEST', () => null);
  const events = tr.processBars(bars);
  assert.equal(events.length, 0, 'must not enter -- the watch was cancelled before confirmation');
  assert.equal(tr.longWatch, false);
  assert.equal(tr.position, null);
});

// --- forceEodClose (added 2026-07-30, user's explicit choice -- diverges from
// the exact backtest, which doesn't day-scope trades at all) ---

test('forceEodClose closes an open position at the last bar\'s own close, tagged EOD_SQUARE_OFF', () => {
  const bars = warmup(PERIOD, 100);
  bars.push(bar(93, 93, PERIOD));
  bars.push(bar(91, 91, PERIOD + 1));
  bars.push(bar(91.5, 91.5, PERIOD + 2));
  bars.push(bar(91.8, 91.8, PERIOD + 3));
  bars.push(bar(94, 96, PERIOD + 4)); // LONG entry at 94, last bar's close=96

  const tr = new WilliamsRLiveTracker('TEST', () => null);
  tr.processBars(bars);
  assert.ok(tr.position);

  const eodEvent = tr.forceEodClose(bars);
  assert.ok(eodEvent);
  assert.equal(eodEvent.type, 'EXIT');
  assert.equal(eodEvent.action, 'EOD_SQUARE_OFF');
  assert.equal(eodEvent.exitPrice, 96); // last bar's close
  assert.equal(eodEvent.theoreticalExit, 96);
  assert.ok(eodEvent.pnlPct > 0, 'entry 94 -> exit 96 should be a winning LONG');
  assert.equal(tr.position, null, 'position must be cleared after EOD close');
});

test('forceEodClose is a no-op when no position is open', () => {
  const bars = warmup(PERIOD, 100);
  const tr = new WilliamsRLiveTracker('TEST', () => null);
  tr.processBars(bars);
  assert.equal(tr.position, null);
  assert.equal(tr.forceEodClose(bars), null);
});

test('forceEodClose uses live LTP when available, same as a normal exit', () => {
  const bars = warmup(PERIOD, 100);
  bars.push(bar(93, 93, PERIOD));
  bars.push(bar(91, 91, PERIOD + 1));
  bars.push(bar(91.5, 91.5, PERIOD + 2));
  bars.push(bar(91.8, 91.8, PERIOD + 3));
  bars.push(bar(94, 96, PERIOD + 4));

  const tr = new WilliamsRLiveTracker('TEST', () => 95.25);
  tr.processBars(bars);
  const eodEvent = tr.forceEodClose(bars);
  assert.equal(eodEvent.exitPrice, 95.25); // live LTP, not the theoretical close (96)
  assert.equal(eodEvent.theoreticalExit, 96);
  assert.equal(eodEvent.livePriceAvailable, true);
});

test('forceEodClose does NOT reset pendingEntry/watch-state -- only the open position is cleared', () => {
  const bars = warmup(PERIOD, 100);
  bars.push(bar(93, 93, PERIOD));
  bars.push(bar(91, 91, PERIOD + 1));
  bars.push(bar(91.5, 91.5, PERIOD + 2));
  bars.push(bar(91.8, 91.8, PERIOD + 3));
  bars.push(bar(94, 96, PERIOD + 4)); // LONG entry -- position open

  const tr = new WilliamsRLiveTracker('TEST', () => null);
  tr.processBars(bars);
  assert.ok(tr.position);

  // Manually seed some watch-state to prove forceEodClose leaves it alone.
  tr.shortWatch = true;
  tr.shortDownStreak = 1;

  tr.forceEodClose(bars);
  assert.equal(tr.position, null);
  assert.equal(tr.shortWatch, true, 'watch-state must survive EOD close -- only exposure is closed, not indicator state');
  assert.equal(tr.shortDownStreak, 1);
});
