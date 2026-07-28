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
 * Reuses the DarvasBox ENTRY rule directly from ../strategies.js (this
 * directory's own fresh backtest code, already validated against the
 * 352-stock and watchlist runs) -- NOT duplicated or reimplemented here,
 * so live and backtest can never silently drift apart on what counts as a
 * signal.
 *
 * FORK for the 0.25%-brick / LTP-confirmed shadow trade (2026-07-27),
 * exit mechanism REPLACED 2026-07-28 -- deliberate deviations from the
 * original tracker this was copied from --
 *   1. Brick-CONFIRMED entries are priced at the live LTP at confirmation
 *      time, not the theoretical brick close -- same reasoning as
 *      execution_revision.js on the ORB project and the LTP-vs-brick-price
 *      analysis done on the Renko N/K grid: a brick's close can already be
 *      stale by the time it's confirmed and dispatched. Falls back to the
 *      theoretical brick close if no live price is available (getLivePriceFn
 *      returns null/undefined or isn't provided).
 *   2. Exit is ENTIRELY a 9/20 EMA crossover on 5-minute bars
 *      (checkEmaCrossExit, below), not brick-driven at all -- the flat/
 *      box/chandelier stop ratchet that used to live in strategies.js's
 *      DarvasBox getExit was scrapped outright (backtest 2026-07-28 showed
 *      the EMA-cross exit beating the actual booked flat-1%-stop result on
 *      real trades: +2,885 vs +2,828 on 1-min EMAs, +3,181 vs +2,828 on
 *      5-min EMAs -- 5-min chosen here). There is deliberately NO stop-loss
 *      of any kind anymore: a losing trade rides until the EMAs cross or
 *      the forced EOD square-off, whichever comes first. getExit() in
 *      strategies.js is now a permanent no-op for DarvasBox; entries still
 *      go through it (box-breakout logic unchanged), but no code path here
 *      ever calls getExit or getStop.
 */

const { strategies } = require('./strategies');
const darvas = strategies.find((s) => s.name === 'DarvasBox');
if (!darvas) throw new Error('DarvasBox strategy not found in strategies.js');

const EMA_FAST = 9;
const EMA_SLOW = 20;

/** Standard exponential moving average, seeded with a simple average over the first `period` values. Returns null for indices before the seed point. */
function computeEma(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { sum += closes[i]; continue; }
    if (i === period - 1) { sum += closes[i]; out[i] = sum / period; continue; }
    out[i] = closes[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

class DarvasLiveTracker {
  constructor(symbol, getLivePriceFn) {
    this.symbol = symbol;
    this.getLivePriceFn = getLivePriceFn || (() => null);
    this.position = null;
    this.processedBrickCount = 0;
    this.processedBar5Count = 0;
  }

  resetForNewDay() {
    this.position = null;
    this.processedBrickCount = 0;
    this.processedBar5Count = 0;
  }

  _liveOrTheoretical(theoreticalPrice) {
    const live = this.getLivePriceFn();
    return { price: live != null ? live : theoreticalPrice, livePriceAvailable: live != null, theoreticalPrice };
  }

  /** bricks = ALL of today's bricks so far (rebuilt fresh each poll). Entries only -- see module docstring. Returns new ENTRY events since the last call. */
  processBricks(bricks) {
    const ctx = { bricks };
    const events = [];
    const start = Math.max(1, this.processedBrickCount);

    for (let i = start; i < bricks.length; i++) {
      if (!this.position) {
        const direction = darvas.getEntry(i, ctx);
        if (direction) {
          const theoreticalEntry = bricks[i].close;
          const { price: realEntry, livePriceAvailable } = this._liveOrTheoretical(theoreticalEntry);
          this.position = { direction, entry: realEntry, entryIdx: i, entryTimestampMs: bricks[i].timestampMs };
          events.push({
            type: 'ENTRY', symbol: this.symbol, direction, entry: realEntry, theoreticalEntry,
            entryIdx: i, timestampMs: bricks[i].timestampMs, livePriceAvailable,
          });
        }
      }
    }
    this.processedBrickCount = bricks.length;
    return events;
  }

  /**
   * The ONLY exit mechanism: a 9/20 EMA crossover on 5-minute bars. LONG
   * exits on a bearish cross (EMA9 was >= EMA20, now <), SHORT exits on a
   * bullish cross (EMA9 was <= EMA20, now >). No stop-loss -- see module
   * docstring for why this was deliberately scrapped.
   *
   * `bars5` = ALL of today's 5-minute bars so far (aggregate 1-min bars via
   * bar_aggregator.js::aggregateTo5Min before calling this -- same pattern
   * as processBricks: rebuilt fresh each poll, recomputing the EMA series
   * from scratch each call since a day's worth of 5-min bars is tiny
   * (~75 max) and EMA is a cheap recursive scan). Only bars strictly after
   * entryTimestampMs are eligible, same "skip the entry bar" convention the
   * old checkIntrabarStop used, since a bar at/before entry can't be
   * trusted to postdate the signal. Call this AFTER processBricks() each
   * poll, mirroring streamer.js's existing cadence.
   */
  checkEmaCrossExit(bars5) {
    const start = Math.max(1, this.processedBar5Count);
    this.processedBar5Count = bars5.length;
    if (!this.position) return null;

    const closes = bars5.map((b) => b.close);
    const emaFast = computeEma(closes, EMA_FAST);
    const emaSlow = computeEma(closes, EMA_SLOW);
    const pos = this.position;

    for (let i = start; i < bars5.length; i++) {
      if (bars5[i].timestampMs <= pos.entryTimestampMs) continue;
      if (emaFast[i] == null || emaSlow[i] == null || emaFast[i - 1] == null || emaSlow[i - 1] == null) continue;
      const bearishCross = emaFast[i - 1] >= emaSlow[i - 1] && emaFast[i] < emaSlow[i];
      const bullishCross = emaFast[i - 1] <= emaSlow[i - 1] && emaFast[i] > emaSlow[i];
      if ((pos.direction === 'LONG' && bearishCross) || (pos.direction === 'SHORT' && bullishCross)) {
        const { price: realExit, livePriceAvailable } = this._liveOrTheoretical(bars5[i].close);
        const pnlPct = pos.direction === 'LONG'
          ? ((realExit - pos.entry) / pos.entry) * 100
          : ((pos.entry - realExit) / pos.entry) * 100;
        this.position = null;
        return {
          type: 'EXIT',
          symbol: this.symbol,
          direction: pos.direction,
          entry: pos.entry,
          exitPrice: realExit,
          theoreticalExit: bars5[i].close,
          livePriceAvailable,
          action: 'EMA_9_20_CROSS',
          barsHeld: null,
          pnlPct,
          entryTimestampMs: pos.entryTimestampMs,
          exitTimestampMs: bars5[i].timestampMs,
        };
      }
    }
    return null;
  }

  /** Called at/after 15:30 IST if a position is still open -- forced EOD square-off. */
  forceEodClose(bricks) {
    if (!this.position || bricks.length === 0) return null;
    const last = bricks[bricks.length - 1];
    const { price: realExit, livePriceAvailable } = this._liveOrTheoretical(last.close);
    return this._close(bricks, bricks.length - 1, 'EOD_SQUARE_OFF', realExit, last.close, livePriceAvailable);
  }

  _close(bricks, exitIdx, action, exitPrice, theoreticalExit, livePriceAvailable) {
    const pos = this.position;
    const pnlPct = pos.direction === 'LONG' ? ((exitPrice - pos.entry) / pos.entry) * 100 : ((pos.entry - exitPrice) / pos.entry) * 100;
    this.position = null;
    return {
      type: 'EXIT',
      symbol: this.symbol,
      direction: pos.direction,
      theoreticalExit,
      livePriceAvailable,
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
