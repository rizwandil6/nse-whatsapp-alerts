'use strict';

/**
 * Resumable, per-symbol DarvasBox event detector for the live poller.
 * Each poll rebuilds the FULL set of today's Renko bricks from scratch
 * (renko.js is deterministic and today's candles only ever grow, never
 * change retroactively), then this tracker replays only the bricks it
 * hasn't seen yet against persisted position state -- so a poll never
 * re-alerts something it already fired on, and a process restart just
 * needs `processedBrickCount` reset to 0 to safely replay the whole day
 * (events for brick indices before the restart are naturally re-derived
 * identically, since the walk is deterministic).
 *
 * Reuses the DarvasBox entry/exit/stop rules directly from
 * ../strategies.js (this directory's own fresh backtest code, already
 * validated against the 352-stock and watchlist runs) -- NOT duplicated
 * or reimplemented here, so live and backtest can never silently drift
 * apart on what counts as a signal.
 */

const { strategies } = require('./strategies');
const darvas = strategies.find((s) => s.name === 'DarvasBox');
if (!darvas) throw new Error('DarvasBox strategy not found in strategies.js');

class DarvasLiveTracker {
  constructor(symbol) {
    this.symbol = symbol;
    this.position = null;
    this.processedBrickCount = 0;
    this.processedBarCount = 0;
  }

  resetForNewDay() {
    this.position = null;
    this.processedBrickCount = 0;
    this.processedBarCount = 0;
  }

  /** bricks = ALL of today's bricks so far (rebuilt fresh each poll, single trading day only). Returns new events since the last call. */
  processBricks(bricks) {
    const ctx = { bricks };
    const events = [];
    const start = Math.max(1, this.processedBrickCount);

    for (let i = start; i < bricks.length; i++) {
      if (this.position) {
        const b = bricks[i];
        const stopHit = this.position.direction === 'LONG'
          ? (b.direction === 'down' && b.low <= this.position.stop)
          : (b.direction === 'up' && b.high >= this.position.stop);
        if (stopHit) {
          events.push(this._close(bricks, i, 'STOP_LOSS', this.position.stop));
          continue;
        }
        const exitReason = darvas.getExit(i, ctx, this.position);
        if (exitReason) {
          events.push(this._close(bricks, i, exitReason, b.close));
          continue;
        }
      }
      if (!this.position) {
        const direction = darvas.getEntry(i, ctx);
        if (direction) {
          const stop = darvas.getStop(i, ctx, direction, i);
          if (stop != null) {
            this.position = { direction, entry: bricks[i].close, entryIdx: i, stop, entryTimestampMs: bricks[i].timestampMs };
            events.push({ type: 'ENTRY', symbol: this.symbol, direction, entry: bricks[i].close, stop, entryIdx: i, timestampMs: bricks[i].timestampMs });
          }
        }
      }
    }
    this.processedBrickCount = bricks.length;
    return events;
  }

  /**
   * Checks the REAL 5-min bar lows/highs (not a brick's synthetic low/high,
   * which is just min/max(open,close) of that brick -- see renko.js) against
   * the current stop and trailing-stop, independent of whether a Renko brick
   * has confirmed anything yet.
   *
   * Why this exists: the brick-based check alone can lag a real stop hit by
   * hours. Confirmed live 2026-07-23 on TRITURBINE -- real price touched the
   * stop at 10:15 IST, but the close-only, 2x-reversal-confirmed brick logic
   * didn't register the exit until 12:30 IST, because 5-min closes kept
   * missing the threshold needed to flip a down brick. A real SL order on
   * the exchange would have filled at 10:15, not 12:30.
   *
   * `bars` = ALL of today's 5-min bars so far (same array processBricks'
   * caller builds bricks from). Only scans bars not yet checked
   * (processedBarCount), mirroring processBricks' own resumability
   * convention, and only fires once a position exists to check against.
   * Call this AFTER processBricks() each poll, so a position entered this
   * same cycle is still checked against its own entry bar's wick.
   */
  checkIntrabarStop(bars) {
    const start = this.processedBarCount;
    this.processedBarCount = bars.length;
    if (!this.position) return null;

    for (let i = start; i < bars.length; i++) {
      const bar = bars[i];
      const pos = this.position;
      // A bar's OHLC doesn't tell us whether its low/high came before or
      // after a price move within that same bar -- so a bar at/before the
      // entry bar can't be judged (its low may predate the entry signal
      // entirely, e.g. TRITURBINE 2026-07-23: the entry bar's own low was
      // below the freshly-set stop, but only because of price action
      // BEFORE that bar rallied into the breakout). Only bars strictly
      // after the entry bar are eligible.
      if (bar.timestampMs <= pos.entryTimestampMs) continue;
      let hitPrice = null;
      if (pos.direction === 'LONG') {
        if (bar.low <= pos.stop) hitPrice = pos.stop;
        else if (pos.trailStop != null && bar.low <= pos.trailStop) hitPrice = pos.trailStop;
      } else {
        if (bar.high >= pos.stop) hitPrice = pos.stop;
        else if (pos.trailStop != null && bar.high >= pos.trailStop) hitPrice = pos.trailStop;
      }
      if (hitPrice != null) {
        const pnlPct = pos.direction === 'LONG' ? ((hitPrice - pos.entry) / pos.entry) * 100 : ((pos.entry - hitPrice) / pos.entry) * 100;
        this.position = null;
        return {
          type: 'EXIT',
          symbol: this.symbol,
          direction: pos.direction,
          entry: pos.entry,
          exitPrice: hitPrice,
          action: 'INTRABAR_STOP_LOSS',
          barsHeld: null,
          pnlPct,
          entryTimestampMs: pos.entryTimestampMs,
          exitTimestampMs: bar.timestampMs,
        };
      }
    }
    return null;
  }

  /**
   * Checks a single live tick's LTP against the current stop/trailing-stop
   * -- the fastest possible stop detection this tracker supports, since a
   * tick is checked the instant it arrives instead of waiting for a bar or
   * brick boundary (see streamer.js). Unlike checkIntrabarStop, a tick is
   * consumed exactly once and never replayed, so no resumability counter
   * is needed here.
   *
   * `tick` = { ltp, lttMs }. Skips ticks at/before entryTimestampMs for the
   * same reason checkIntrabarStop excludes the entry bar -- a tick can't be
   * trusted to postdate the entry signal otherwise (e.g. a backfilled/
   * replayed tick during reconnect-gap recovery). Touch-based (LTP crossing
   * the level), same philosophy as checkIntrabarStop's bar low/high check
   * -- deliberately more aggressive than the brick trailing-stop's
   * close-cross rule (strategies.js TRAILING_BOX_STOP), since the entire
   * point is not waiting for confirmation.
   */
  checkTickStop(tick) {
    if (!this.position) return null;
    const pos = this.position;
    if (tick.lttMs <= pos.entryTimestampMs) return null;

    let hitPrice = null;
    if (pos.direction === 'LONG') {
      if (tick.ltp <= pos.stop) hitPrice = pos.stop;
      else if (pos.trailStop != null && tick.ltp <= pos.trailStop) hitPrice = pos.trailStop;
    } else {
      if (tick.ltp >= pos.stop) hitPrice = pos.stop;
      else if (pos.trailStop != null && tick.ltp >= pos.trailStop) hitPrice = pos.trailStop;
    }
    if (hitPrice == null) return null;

    const pnlPct = pos.direction === 'LONG'
      ? ((hitPrice - pos.entry) / pos.entry) * 100
      : ((pos.entry - hitPrice) / pos.entry) * 100;
    this.position = null;
    return {
      type: 'EXIT',
      symbol: this.symbol,
      direction: pos.direction,
      entry: pos.entry,
      exitPrice: hitPrice,
      action: 'TICK_STOP_LOSS',
      barsHeld: null,
      pnlPct,
      entryTimestampMs: pos.entryTimestampMs,
      exitTimestampMs: tick.lttMs,
    };
  }

  /** Called at/after 15:30 IST if a position is still open -- forced EOD square-off. */
  forceEodClose(bricks) {
    if (!this.position || bricks.length === 0) return null;
    const last = bricks[bricks.length - 1];
    return this._close(bricks, bricks.length - 1, 'EOD_SQUARE_OFF', last.close);
  }

  _close(bricks, exitIdx, action, exitPrice) {
    const pos = this.position;
    const pnlPct = pos.direction === 'LONG' ? ((exitPrice - pos.entry) / pos.entry) * 100 : ((pos.entry - exitPrice) / pos.entry) * 100;
    this.position = null;
    return {
      type: 'EXIT',
      symbol: this.symbol,
      direction: pos.direction,
      entry: pos.entry,
      exitPrice,
      action,
      barsHeld: exitIdx - pos.entryIdx,
      pnlPct,
      entryTimestampMs: bricks[pos.entryIdx].timestampMs,
      exitTimestampMs: bricks[exitIdx].timestampMs,
    };
  }
}

module.exports = { DarvasLiveTracker };
