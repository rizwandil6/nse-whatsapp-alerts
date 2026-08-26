'use strict';

/**
 * Backtest runner -- replays real historical Pi42 LAST_PRICE 1-min data through the ACTUAL
 * production IcSymbolTracker class (ic_engine.js), not a reimplementation, so results are
 * guaranteed consistent with what the live bot would really do. 15-min bars are aggregated
 * directly from the same 1-min data (not pulled as a separate Pi42 klines call) so there's no
 * risk of the exact same seed/live consistency bug this session just fixed (see pi42_client.js's
 * 2026-08-26 MARK_PRICE -> LAST_PRICE fix) creeping back in via a second, independently-computed
 * candle series.
 *
 * Usage: node backtest.js [SYMBOL] [1m-bar-count]
 *   node backtest.js XAUINR 1500
 */

const { fetchKlines } = require('./pi42_client');
const { IcSymbolTracker } = require('./ic_engine');

const SYMBOL = process.argv[2] || 'XAUINR';
const LOOKBACK = Number(process.argv[3] || 1500); // 1500 x 1min ~= 25 hours

function fmtPx(x) { return x == null ? '—' : Number(x).toFixed(2); }
function iso(ms) { return new Date(ms).toISOString(); }

function aggregate15m(bars1m) {
  const out = [];
  let bucket = null;
  for (const b of bars1m) {
    const bucketStart = Math.floor(b.timestampMs / (15 * 60 * 1000)) * (15 * 60 * 1000);
    if (!bucket || bucket.timestampMs !== bucketStart) {
      if (bucket) out.push(bucket);
      bucket = { timestampMs: bucketStart, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      bucket.high = Math.max(bucket.high, b.high);
      bucket.low = Math.min(bucket.low, b.low);
      bucket.close = b.close;
      bucket.volume += b.volume;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

(async () => {
  console.log(`Fetching ${LOOKBACK} 1-min LAST_PRICE bars for ${SYMBOL}...`);
  const bars1m = await fetchKlines(SYMBOL, '1m', LOOKBACK);
  console.log(`Got ${bars1m.length} bars: ${iso(bars1m[0].timestampMs)} -> ${iso(bars1m[bars1m.length - 1].timestampMs)}`);

  const bars15m = aggregate15m(bars1m);
  console.log(`Aggregated into ${bars15m.length} 15-min bars.\n`);

  const tracker = new IcSymbolTracker(SYMBOL, { entriesEnabled: true });
  tracker.seedHistory([]); // start fresh -- no external seed, fully transparent replay

  const events = [];
  let m15Idx = 0;
  for (const b1 of bars1m) {
    for (const e of tracker.addM1Bar(b1)) events.push(e);

    const bucketStart = Math.floor(b1.timestampMs / (15 * 60 * 1000)) * (15 * 60 * 1000);
    const isLastMinuteOfBucket = (b1.timestampMs + 60000) >= (bucketStart + 15 * 60 * 1000);
    if (isLastMinuteOfBucket && m15Idx < bars15m.length && bars15m[m15Idx].timestampMs === bucketStart) {
      for (const e of tracker.addM15Bar(bars15m[m15Idx])) events.push(e);
      m15Idx++;
    }
  }

  const setups = events.filter((e) => e.type === 'SETUP');
  const outcomes = events.filter((e) => e.type === 'OUTCOME');
  const insideCandles = events.filter((e) => e.type === 'DIAGNOSTIC' && e.isInside);

  console.log(`=== ${SYMBOL} backtest results ===`);
  console.log(`${insideCandles.length} inside candles formed, ${setups.length} setups fired, ${outcomes.length} resolved.\n`);

  for (const e of events) {
    if (e.type === 'SETUP') {
      console.log(`[SETUP]   ${iso(e.entryTs)}  ${e.direction}  entry=${fmtPx(e.entryPx)}  stop=${fmtPx(e.stop)}  target=${fmtPx(e.target)}  IC(${fmtPx(e.icLow)}-${fmtPx(e.icHigh)})`);
    } else if (e.type === 'OUTCOME') {
      console.log(`[OUTCOME] ${iso(e.closedTs)}  ${e.result}  exit=${fmtPx(e.exitPx)}  R=${e.rMultiple >= 0 ? '+' : ''}${Number(e.rMultiple).toFixed(2)}`);
    }
  }

  if (setups.length) {
    const wins = outcomes.filter((o) => o.rMultiple >= 0).length;
    console.log(`\nWin rate: ${outcomes.length ? ((wins / outcomes.length) * 100).toFixed(1) : '—'}% (${wins}/${outcomes.length} resolved; ${setups.length - outcomes.length} still open at end of window)`);
  }
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
