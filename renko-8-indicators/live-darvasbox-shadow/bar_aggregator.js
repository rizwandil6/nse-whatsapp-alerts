'use strict';

/**
 * Shared IST time helpers + 5-min bar aggregation, used by both the REST
 * poller (poller.js) and the tick-WebSocket streamer (streamer.js) so the
 * two entry points can never silently drift on market-hours/bucketing
 * rules while they're being run side by side during validation.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;
// SEBI's new Closing Auction Session (effective 2026-08-03) ends continuous
// order-matching for F&O-eligible stocks at 15:15 -- 3:15-3:35 is auction-only,
// not a normal fill. FNO_CLOSE_MIN gives a few minutes of buffer before that
// so a forced EOD square-off order actually lands in continuous trading, not
// the auction window. Non-F&O stocks are unaffected (still continuous to
// 15:30) and keep using MARKET_CLOSE_MIN. See fno_underlyings.js.
const FNO_CLOSE_MIN = 15 * 60 + 12;

function istMinutesOfDay(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function istDateStr(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}
function nowIst() {
  const now = Date.now();
  return { minutesOfDay: istMinutesOfDay(now), dateStr: istDateStr(now) };
}

/**
 * Single-trading-day only -- buckets purely by minutes-of-day, so candles
 * from DIFFERENT calendar days sharing the same time-of-day (e.g. 09:20 on
 * two different dates) would silently collide into the same bucket if fed
 * multi-day input. Callers with multi-day candles must use
 * aggregateTo5MinMultiDay instead, which groups by date first.
 */
function aggregateTo5Min(oneMinCandles) {
  const buckets = new Map();
  for (const c of oneMinCandles) {
    const min = istMinutesOfDay(c.timestampMs);
    if (min < MARKET_OPEN_MIN) continue;
    const bucketIdx = Math.floor((min - MARKET_OPEN_MIN) / 5);
    const key = String(bucketIdx);
    if (!buckets.has(key)) {
      buckets.set(key, { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, timestampMs: c.timestampMs });
    } else {
      const b = buckets.get(key);
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

/**
 * Multi-day-safe version of aggregateTo5Min -- groups input candles by IST
 * calendar date first (so two different days' 09:20 buckets can never
 * collide), then runs the existing per-day bucketing on each date's group
 * independently, concatenating the results in chronological order.
 *
 * Added 2026-07-29 for continuous (non-daily-reset) EMA warm-up: DarvasBox's
 * 9/20 EMA-cross exit used to recompute from scratch at market open every
 * day, meaning EMA(20) had no valid value for the first ~100 minutes of
 * every session (20 bars x 5 min) -- a real, confirmed gap (RAILTEL/SUZLON/
 * WAAREEENER all sat with an already-unfavorable EMA relationship at
 * warm-up that could never register as a "cross" transition) and a
 * fundamental mismatch with how every standard chart computes EMA
 * (continuously across days, not reset daily). Feeding several PRIOR
 * trading days' bars into the EMA calculation (see streamer.js's
 * historicalBars5) via this function fixes both at once: EMA(20) is
 * already fully converged by the time today's first bar arrives, and the
 * resulting values line up with what a normal chart shows.
 */
function aggregateTo5MinMultiDay(oneMinCandles) {
  const byDate = new Map();
  for (const c of oneMinCandles) {
    const d = istDateStr(c.timestampMs);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(c);
  }
  const dates = [...byDate.keys()].sort();
  const result = [];
  for (const d of dates) result.push(...aggregateTo5Min(byDate.get(d)));
  return result;
}

module.exports = {
  IST_OFFSET_MS,
  MARKET_OPEN_MIN,
  MARKET_CLOSE_MIN,
  FNO_CLOSE_MIN,
  istMinutesOfDay,
  istDateStr,
  nowIst,
  aggregateTo5Min,
  aggregateTo5MinMultiDay,
};
