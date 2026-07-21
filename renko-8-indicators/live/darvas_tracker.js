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
  }

  resetForNewDay() {
    this.position = null;
    this.processedBrickCount = 0;
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
            this.position = { direction, entry: bricks[i].close, entryIdx: i, stop };
            events.push({ type: 'ENTRY', symbol: this.symbol, direction, entry: bricks[i].close, stop, entryIdx: i, timestampMs: bricks[i].timestampMs });
          }
        }
      }
    }
    this.processedBrickCount = bricks.length;
    return events;
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
