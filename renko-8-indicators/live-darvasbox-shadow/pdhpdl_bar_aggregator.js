'use strict';

/**
 * Buckets a stream of 1-minute candles into fixed-size bars (5-min OR
 * 15-min), anchored to NSE's real session boundaries (9:15, 9:20, ... for
 * 5-min; 9:15, 9:30, ... for 15-min), not just "every Nth candle received"
 * — robust against WebSocket gaps/reconnects where a few 1-min candles
 * might be missed or arrive out of order.
 *
 * Generalised from ema-scalp-strategy/live/bar_aggregator.js: the window
 * size is now a constructor arg so the PDH/PDL scanner can run a 5-min
 * aggregator (entry timeframe) and a 15-min aggregator (confirmation
 * timeframe) off the same 1-min tick stream per symbol.
 */

const IST_OFFSET_MS = 5.5 * 3600000;
const SESSION_START_MINUTES = 9 * 60 + 15; // 9:15 IST

function istMinutesSinceMidnight(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Epoch ms of the start of the `sizeMin`-minute window (session-anchored) that `ms` falls into. */
function windowStart(ms, sizeMin) {
  const istMs = ms + IST_OFFSET_MS;
  const istDayStartMs = Math.floor(istMs / 86400000) * 86400000;
  const minutesSinceMidnight = (istMs - istDayStartMs) / 60000;
  const minutesSinceSession = minutesSinceMidnight - SESSION_START_MINUTES;
  const windowIndex = Math.floor(minutesSinceSession / sizeMin);
  const windowStartMinutes = SESSION_START_MINUTES + windowIndex * sizeMin;
  const windowStartIstMs = istDayStartMs + windowStartMinutes * 60000;
  return windowStartIstMs - IST_OFFSET_MS;
}

/**
 * Stateful per-symbol aggregator. Call push(oneMinCandle) for every new
 * 1-min candle; it calls onBarComplete(bar) whenever a window closes out
 * (i.e. a candle from the NEXT window arrives).
 */
class BarAggregator {
  constructor(sizeMin, onBarComplete) {
    this.sizeMin = sizeMin;
    this.onBarComplete = onBarComplete;
    this.currentWindowStart = null;
    this.buffer = [];
    this.seenTimestamps = new Set();
  }

  push(oneMinCandle) {
    if (this.seenTimestamps.has(oneMinCandle.timestampMs)) return; // dedupe re-delivered candles
    this.seenTimestamps.add(oneMinCandle.timestampMs);

    const ws = windowStart(oneMinCandle.timestampMs, this.sizeMin);

    if (this.currentWindowStart === null) {
      this.currentWindowStart = ws;
      this.buffer = [oneMinCandle];
      return;
    }
    if (ws === this.currentWindowStart) {
      this.buffer.push(oneMinCandle);
      return;
    }
    if (ws > this.currentWindowStart) {
      this._flush();
      this.currentWindowStart = ws;
      this.buffer = [oneMinCandle];
      return;
    }
    // ws < currentWindowStart: a late/out-of-order candle for an already-closed
    // window arrived. Drop it — the bar already finalized without it.
  }

  _flush() {
    if (this.buffer.length === 0) return;
    const sorted = this.buffer.slice().sort((a, b) => a.timestampMs - b.timestampMs);
    const bar = {
      timestampMs: this.currentWindowStart,
      open: sorted[0].open,
      high: Math.max(...sorted.map((c) => c.high)),
      low: Math.min(...sorted.map((c) => c.low)),
      close: sorted[sorted.length - 1].close,
      volume: sorted.reduce((s, c) => s + (c.volume || 0), 0),
    };
    this.onBarComplete(bar);
  }

  /** Force-close whatever's in the buffer (call at end of day / market close). */
  flushRemaining() {
    this._flush();
    this.buffer = [];
  }
}

module.exports = { BarAggregator, windowStart, istMinutesSinceMidnight };
