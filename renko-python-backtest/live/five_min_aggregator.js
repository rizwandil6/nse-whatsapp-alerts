'use strict';

/**
 * Incremental 1-min -> 5-min bar aggregator, feeding EXACTLY ONE candle
 * close per completed 5-min bar into DynamicRenkoBuilder -- deliberately
 * NOT the sibling DarvasBox pattern (bar_aggregator.js::aggregateTo5Min,
 * a stateless batch function re-run over the FULL day's 1-min bars on
 * every single 1-min close, which can include a still-forming, not-yet-
 * complete final bucket in its output). That's safe for DarvasBox only
 * because its Renko rebuild is also stateless/from-scratch every time, so
 * a briefly-wrong partial bar self-corrects on the next tick. This
 * service's Renko builder is INCREMENTAL (see renko_engine.js) -- feeding
 * it a still-forming 5-min bar's close, only to "correct" it a minute
 * later, could register a brick that a later, true close would not have
 * triggered. So here, a 5-min bar is finalized and fed to Renko exactly
 * ONCE, only when its window has genuinely closed.
 *
 * Also avoids retaining the full day's 1-min bars in memory forever (this
 * service runs continuously across days, unlike DarvasBox's daily reset).
 */

const { IST_OFFSET_MS, MARKET_OPEN_MIN } = require('./bar_aggregator');

function istMidnightMs(ms) {
  const istAdjusted = new Date(ms + IST_OFFSET_MS);
  const utcMidnightOfIstDate = Date.UTC(istAdjusted.getUTCFullYear(), istAdjusted.getUTCMonth(), istAdjusted.getUTCDate());
  return utcMidnightOfIstDate - IST_OFFSET_MS;
}

function istMinutesOfDay(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function bucketIndexFor(ms) {
  const min = istMinutesOfDay(ms);
  if (min < MARKET_OPEN_MIN) return null;
  return Math.floor((min - MARKET_OPEN_MIN) / 5);
}

function bucketKeyFor(ms, bucketIdx) {
  return `${istMidnightMs(ms)}-${bucketIdx}`;
}

class FiveMinBarAggregator {
  constructor() {
    this.forming = null; // { bucketKey, bucketIdx, dayMidnightMs, open, high, low, close, timestampMs, volume }
  }

  /** oneMinBar: {timestampMs, open, high, low, close, volume}. Returns a completed 5-min bar, or null if still forming. */
  onOneMinBar(oneMinBar) {
    const bucketIdx = bucketIndexFor(oneMinBar.timestampMs);
    if (bucketIdx == null) return null; // pre-market bar, ignore

    const bucketKey = bucketKeyFor(oneMinBar.timestampMs, bucketIdx);

    if (!this.forming) {
      this.forming = this._startBucket(oneMinBar, bucketKey, bucketIdx);
      return null;
    }
    if (bucketKey === this.forming.bucketKey) {
      this.forming.high = Math.max(this.forming.high, oneMinBar.high);
      this.forming.low = Math.min(this.forming.low, oneMinBar.low);
      this.forming.close = oneMinBar.close;
      this.forming.volume += oneMinBar.volume;
      return null;
    }

    // A new bucket started -- the previous one is now definitively closed.
    const completed = this._finalize();
    this.forming = this._startBucket(oneMinBar, bucketKey, bucketIdx);
    return completed;
  }

  /** Force-closes the forming bucket if its 5-min window has fully elapsed with no new 1-min bar arriving (EOD, illiquid gaps) -- mirrors TickBarBuilder.flushIfStale one level up. */
  flushIfStale(nowMs) {
    if (!this.forming) return null;
    const bucketEndMs = this.forming.dayMidnightMs + (MARKET_OPEN_MIN + (this.forming.bucketIdx + 1) * 5) * 60000;
    if (nowMs >= bucketEndMs) return this._finalize();
    return null;
  }

  _startBucket(oneMinBar, bucketKey, bucketIdx) {
    return {
      bucketKey,
      bucketIdx,
      dayMidnightMs: istMidnightMs(oneMinBar.timestampMs),
      open: oneMinBar.open,
      high: oneMinBar.high,
      low: oneMinBar.low,
      close: oneMinBar.close,
      timestampMs: oneMinBar.timestampMs, // bucket START time, matching data/{symbol}.csv's convention (each row = bar open time)
      volume: oneMinBar.volume,
    };
  }

  _finalize() {
    const f = this.forming;
    this.forming = null;
    return { open: f.open, high: f.high, low: f.low, close: f.close, timestampMs: f.timestampMs, volume: f.volume };
  }
}

module.exports = { FiveMinBarAggregator };
