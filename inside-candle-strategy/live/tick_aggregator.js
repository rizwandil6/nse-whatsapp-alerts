'use strict';

/**
 * Builds OHLC candles from Pi42's raw `markPriceUpdate` tick stream (~1/sec, single price field
 * `p`), since Pi42 has no ready-made Mark Price *kline* topic on its WebSocket -- only the
 * Last-Price-based `kline` topic gives pre-built candles. Confirmed empirically (2026-08-30) that
 * `p` matches the REST `/v1/market/klines?priceType=MARK_PRICE` close value exactly.
 *
 * One TickAggregator per symbol. Feed every tick via addTick(); it maintains one "forming"
 * bucket per configured timeframe (1m + each of SIGNAL_TIMEFRAMES) and returns any bars that just
 * closed as a result of this tick (usually none, occasionally one per timeframe when a boundary
 * is crossed). Bucketing/rollover-detection mirrors the same transition-style idiom already used
 * for kline events (streamer.js#onKlineEvent) and for backtest aggregation (backtest.js) -- a
 * bucket is "closed" the moment a tick lands in the NEXT bucket, gaps or not, no assumption that
 * ticks arrive at exact boundaries or that none are missed.
 *
 * Volume is always 0 -- markPriceUpdate carries no trade-volume information (confirmed: Mark
 * Price REST klines report volume=0 too, see wiki/reference/inside-candle-liquidity-sweep-pine.md
 * "Live bot v6" for the full investigation). ic_engine.js never reads volume for any decision, so
 * this is inert, not a data-quality gap that affects trading logic.
 *
 * Restart resilience (bug found + fixed 2026-08-30, live): unlike IcSymbolTracker's own m15
 * history (re-seeded from REST via seedHistory() on every process start), this class has no
 * persistence -- if the process restarts mid-period, `forming` resets to empty and the first
 * ticks received after reconnect start a BRAND NEW bucket. That bucket's timestampMs is still
 * computed correctly (floor() of the real tick time), but its OHLC only reflects however many
 * ticks arrived after the restart -- a fraction of the real period, not the whole thing. Confirmed
 * live: a genuine SOLINR:15m false signal traced back to an icHigh/icLow that exactly matched a
 * single 1-MINUTE bar's range, not any real 15-minute bucket, right after an apparent restart.
 * Fix: the first bucket seen per timeframe after each (re)start is always discarded rather than
 * emitted -- every bucket from the second one onward is guaranteed to have accumulated ticks for
 * its ENTIRE period, since by then the aggregator was already running throughout.
 */

const TF_MS = { '1m': 60000, '5m': 5 * 60000, '15m': 15 * 60000, '30m': 30 * 60000, '1h': 60 * 60000 };

class TickAggregator {
  constructor(symbol, timeframes) {
    this.symbol = symbol;
    this.timeframes = timeframes; // e.g. ['1m', '15m', '5m']
    this.forming = {}; // tf -> { timestampMs, open, high, low, close, volume }
    this.trusted = {}; // tf -> bool, true once the first (possibly-partial) bucket has been discarded
  }

  /** Feed one tick (price, ms epoch timestamp). Returns an array of { tf, bar } for any bars that
   *  just closed as a result of this tick crossing a bucket boundary. The very first bucket per
   *  timeframe is never included here (see class comment) -- discarded silently, not emitted. */
  addTick(price, tickTs) {
    const closed = [];
    for (const tf of this.timeframes) {
      const bms = TF_MS[tf];
      if (!bms) continue;
      const bucketStart = Math.floor(tickTs / bms) * bms;
      const prev = this.forming[tf];
      if (!prev || prev.timestampMs !== bucketStart) {
        if (prev) {
          if (this.trusted[tf]) {
            closed.push({ tf, bar: prev });
          } else {
            this.trusted[tf] = true; // discard this one (possibly partial), trust every bucket from here on
          }
        }
        this.forming[tf] = { timestampMs: bucketStart, open: price, high: price, low: price, close: price, volume: 0 };
      } else {
        prev.high = Math.max(prev.high, price);
        prev.low = Math.min(prev.low, price);
        prev.close = price;
      }
    }
    return closed;
  }
}

module.exports = { TickAggregator, TF_MS };
