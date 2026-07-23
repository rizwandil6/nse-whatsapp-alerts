'use strict';

/**
 * Builds 1-minute OHLCV bars locally from raw LTPC ticks, instead of
 * trusting Upstox's own pre-aggregated `marketOHLC` "I1" candle field --
 * live-diagnosed (2026-07-15) to lag Upstox's own tick stream, anywhere
 * from ~1-2 minutes (baseline, even on a freshly opened connection) up
 * to multiple HOURS during a live session (CRISIL's real 09:42 breakout
 * wasn't alerted until 13:36 that day). `LTPC.ltt` (last trade time) was
 * directly verified in a live diagnostic to track wall-clock closely --
 * often exact to the second -- so ticks are the reliable primitive; the
 * connection/transport was never the problem, only Upstox's server-side
 * candle aggregation was.
 *
 * Volume is derived from `vtt` (cumulative volume traded today) deltas,
 * not summed per-tick quantities -- so a dropped/missed WS message never
 * silently undercounts a bar's volume; the delta between two vtt
 * readings is correct regardless of how many ticks arrived in between.
 */

const LIVE_PRICE_STALE_MS = 60000; // getLivePrice() refuses to answer once its last update is older than this

class TickBarBuilder {
  constructor() {
    this.forming = null; // { minuteStart, open, high, low, close, tbq, tsq }
    this.barStartVtt = null;
    this.lastVtt = null;
    this.lastObservedPrice = null; // freshest tick.ltp seen, independent of minute-bucketing -- see getLivePrice()
    this.lastObservedAtMs = null; // wall-clock receipt time (Date.now()), NOT the tick's self-reported ltt
  }

  /** tick: { ltp, lttMs, vtt, tbq, tsq }. Returns a completed bar, or null if still forming. */
  onTick(tick) {
    this.lastObservedPrice = tick.ltp;
    this.lastObservedAtMs = Date.now();

    const minuteStart = Math.floor(tick.lttMs / 60000) * 60000;

    if (!this.forming) {
      this.forming = { minuteStart, open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp, tbq: tick.tbq, tsq: tick.tsq };
      this.barStartVtt = tick.vtt;
      this.lastVtt = tick.vtt;
      return null;
    }

    if (minuteStart === this.forming.minuteStart) {
      this.forming.high = Math.max(this.forming.high, tick.ltp);
      this.forming.low = Math.min(this.forming.low, tick.ltp);
      this.forming.close = tick.ltp;
      this.forming.tbq = tick.tbq;
      this.forming.tsq = tick.tsq;
      this.lastVtt = tick.vtt;
      return null;
    }

    if (minuteStart > this.forming.minuteStart) {
      const closed = this._closeForming();
      this.forming = { minuteStart, open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp, tbq: tick.tbq, tsq: tick.tsq };
      this.lastVtt = tick.vtt;
      return closed;
    }

    // minuteStart < forming.minuteStart -- an out-of-order/late tick for an already-closed minute (per
    // its own self-reported ltt). Ignored for bar-forming purposes, same as before -- but lastObservedPrice
    // above already captured its ltp, since a tick with a lagging ltt can still be the freshest real quote
    // we've received (see getLivePrice()'s docstring for the incident this fixes).
    return null;
  }

  /**
   * Returns the single most recent observed price -- the freshest price
   * available at any moment, more current than even the last CLOSED bar.
   * Used to revise alert-time entry/stop/target against real price rather
   * than a theoretical level that may already be stale by dispatch time
   * (see streamer.js's reviseForLiveExecution) -- built after a real
   * incident (ITI, 2026-07-16) where the alerted OR-boundary entry was
   * already far behind actual price by dispatch time.
   *
   * Deliberately tracked independent of `forming.close`/minute-bucketing:
   * a second incident (PHOENIXLTD, 2026-07-17) showed `forming.close` can
   * go stale even while bars keep closing correctly elsewhere in the same
   * pipeline -- a run of ticks whose self-reported `ltt` resolves to an
   * earlier minute than the current forming bar get silently ignored by
   * onTick()'s bar-forming logic (correct there, to keep bar boundaries
   * honest), but their `ltp` is still the freshest real quote seen and
   * should count here. Returns null (never a value we can't vouch for) if
   * nothing has updated this in the last LIVE_PRICE_STALE_MS -- callers
   * must already treat null as "no live price available" and fall back to
   * the theoretical value, so a stale reading now fails the same safe way
   * as no reading at all, instead of silently reporting false confidence.
   */
  getLivePrice() {
    if (this.lastObservedAtMs == null) return null;
    if (Date.now() - this.lastObservedAtMs > LIVE_PRICE_STALE_MS) return null;
    return this.lastObservedPrice;
  }

  /** Force-closes the current forming bar if its minute has fully elapsed per wall clock, even with no new tick since -- needed for EOD and illiquid-minute gaps. Call periodically. */
  flushIfStale(nowMs) {
    if (!this.forming) return null;
    if (nowMs < this.forming.minuteStart + 60000) return null;
    const closed = this._closeForming();
    this.forming = null; // re-initializes fresh on the next tick, whatever minute that lands in
    return closed;
  }

  _closeForming() {
    const bar = {
      timestampMs: this.forming.minuteStart,
      open: this.forming.open,
      high: this.forming.high,
      low: this.forming.low,
      close: this.forming.close,
      volume: Math.max(0, this.lastVtt - this.barStartVtt),
      tbq: this.forming.tbq,
      tsq: this.forming.tsq,
    };
    this.barStartVtt = this.lastVtt;
    return bar;
  }
}

module.exports = { TickBarBuilder };
