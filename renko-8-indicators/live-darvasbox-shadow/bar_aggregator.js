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

module.exports = {
  IST_OFFSET_MS,
  MARKET_OPEN_MIN,
  MARKET_CLOSE_MIN,
  istMinutesOfDay,
  istDateStr,
  nowIst,
  aggregateTo5Min,
};
