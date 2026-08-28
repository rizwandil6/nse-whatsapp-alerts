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
 * 1-min bar counts beyond ~1500 (Pi42's per-call cap, confirmed empirically 2026-08-28) are
 * assembled by paging startTime/endTime via fetchKlinesRange() -- transparent to the rest of this
 * file, which just gets back however many bars it asked for.
 *
 * Usage: node backtest.js [SYMBOL] [1m-bar-count]
 *   node backtest.js XAUINR 1500
 *   node backtest.js XAUINR 64800   # ~45 days
 */

const { fetchKlines, fetchKlinesRange } = require('./pi42_client');
const { IcSymbolTracker, TREND_FILTER_ENABLED, SWING_LOOKBACK } = require('./ic_engine');

const SYMBOL = process.argv[2] || 'XAUINR';
const LOOKBACK = Number(process.argv[3] || 1500); // 1500 x 1min ~= 25 hours
const R_LEVELS = [1, 2, 3, 4, 5];

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

/**
 * R-achieved distribution: independent of the engine's fixed R_TARGET exit, this scans forward
 * from each SETUP's entry through the raw 1-min bars and tracks the running maximum favorable
 * excursion (MFE), in R-multiples of the trade's own risk, UP UNTIL the stop-loss is breached (or
 * the data window ends). Answers "how far did price actually travel in this trade's favor before
 * it would have been stopped out" -- independent of what R_TARGET the live bot happens to be
 * configured with, so it can report the 1R/2R/3R/4R/5R achievement distribution in one pass.
 *
 * Conservative ordering per bar: update MFE from the bar's favorable extreme (high for LONG, low
 * for SHORT) BEFORE checking whether the same bar breached the stop -- if both happen in the same
 * 1-min bar this slightly overstates MFE (can't know true intrabar order), same acknowledged
 * limitation as the engine's own same-bar-ambiguity handling elsewhere in this file.
 */
function analyzeRAchieved(setups, bars1m) {
  // Bars are oldest-first; binary-search-free linear scan is fine at these sizes.
  const results = [];
  for (const s of setups) {
    const startIdx = bars1m.findIndex((b) => b.timestampMs >= s.entryTs);
    if (startIdx === -1) { results.push({ setup: s, maxR: 0, stopped: false, dataEnded: true }); continue; }
    let maxR = 0;
    let stopped = false;
    for (let i = startIdx; i < bars1m.length; i++) {
      const b = bars1m[i];
      if (s.direction === 'LONG') {
        maxR = Math.max(maxR, (b.high - s.entryPx) / s.r);
        if (b.low <= s.stop) { stopped = true; break; }
      } else {
        maxR = Math.max(maxR, (s.entryPx - b.low) / s.r);
        if (b.high >= s.stop) { stopped = true; break; }
      }
    }
    results.push({ setup: s, maxR, stopped, dataEnded: !stopped });
  }
  return results;
}

(async () => {
  console.log(`Fetching ${LOOKBACK} 1-min LAST_PRICE bars for ${SYMBOL}...`);
  const bars1m = LOOKBACK > 1500 ? await fetchKlinesRange(SYMBOL, '1m', LOOKBACK) : await fetchKlines(SYMBOL, '1m', LOOKBACK);
  console.log(`Got ${bars1m.length} bars: ${iso(bars1m[0].timestampMs)} -> ${iso(bars1m[bars1m.length - 1].timestampMs)}`);

  const bars15m = aggregate15m(bars1m);
  console.log(`Aggregated into ${bars15m.length} 15-min bars.`);
  console.log(`Trend filter: ${TREND_FILTER_ENABLED ? `ON (swing lookback ${SWING_LOOKBACK})` : 'OFF'}\n`);

  const tracker = new IcSymbolTracker(SYMBOL, { entriesEnabled: true });
  tracker.seedHistory([]); // start fresh -- no external seed, fully transparent replay

  // Bucket-transition detection (gap-tolerant) instead of matching bars1m against a precomputed
  // bars15m array by index. Bug found 2026-08-28: the old index-matching loop only fired
  // addM15Bar when a 1m bar was the LAST minute of a full 15-min window; a single missing minute
  // anywhere in the feed (e.g. a brief Pi42 data gap) means that condition is never satisfied for
  // that bucket, `m15Idx` never advances, and it silently desyncs FOR THE REST OF THE RUN --
  // confirmed live: one ~2h gap near the start of a 33-day XAUINR pull collapsed inside-candle
  // detection from ~10/101 bars (short window, no gap) to 2/3194 bars (full window, one gap).
  // This mirrors the live streamer's own rollover detection (streamer.js#onKlineEvent): a bucket
  // is "closed" the moment the next bar's own bucketStart differs from the current one, gaps or
  // not -- no assumption that every intervening minute actually arrived.
  const events = [];
  let bucket = null;
  for (const b1 of bars1m) {
    const bucketStart = Math.floor(b1.timestampMs / (15 * 60 * 1000)) * (15 * 60 * 1000);
    if (!bucket || bucket.timestampMs !== bucketStart) {
      if (bucket) { for (const e of tracker.addM15Bar(bucket)) events.push(e); }
      bucket = { timestampMs: bucketStart, open: b1.open, high: b1.high, low: b1.low, close: b1.close, volume: b1.volume };
    } else {
      bucket.high = Math.max(bucket.high, b1.high);
      bucket.low = Math.min(bucket.low, b1.low);
      bucket.close = b1.close;
      bucket.volume += b1.volume;
    }
    for (const e of tracker.addM1Bar(b1)) events.push(e);
  }
  // Deliberately NOT finalizing the trailing `bucket` at end-of-data -- it's still forming (we
  // have no confirmation it actually closed), same as the original bars15m/aggregate15m semantics.

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

  // --- R-achieved distribution (1R..5R), independent of the fixed R_TARGET exit above ---
  const rAnalysis = analyzeRAchieved(setups, bars1m);
  console.log(`\n=== ${SYMBOL} R-achieved distribution (MFE before stop-out, ${setups.length} setups) ===`);
  if (setups.length) {
    for (const level of R_LEVELS) {
      const reached = rAnalysis.filter((r) => r.maxR >= level).length;
      const pct = ((reached / setups.length) * 100).toFixed(1);
      console.log(`  >=${level}R reached: ${reached}/${setups.length} (${pct}%)`);
    }
    const neverReached1R = rAnalysis.filter((r) => r.maxR < 1).length;
    const stillRunning = rAnalysis.filter((r) => r.dataEnded).length;
    console.log(`  Never reached 1R before stop-out: ${neverReached1R}/${setups.length}`);
    console.log(`  Still open / ran out of data before stopping: ${stillRunning}/${setups.length}`);
  } else {
    console.log('  (no setups fired -- nothing to analyze)');
  }

  return { symbol: SYMBOL, setups, outcomes, insideCandles, rAnalysis };
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
