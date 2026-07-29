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
 *   3. Entry gained a trend-alignment filter 2026-07-29: a box breakout
 *      only becomes a real entry if the CURRENT 9/20 EMA relationship (5-min
 *      bars, same EMA_WARMUP-backed series checkEmaCrossExit uses) already
 *      agrees with the breakout's direction -- EMA9 > EMA20 for a LONG,
 *      EMA9 < EMA20 for a SHORT. Confirmed live same day: SUZLON's LONG
 *      breakout fired with EMA9 (48.11) already BELOW EMA20 (48.74) -- a
 *      counter-trend entry that sat underwater the whole session. Backtest
 *      against that day's 19 real entries: the 5 this filter would have
 *      skipped included zero realized winners (3 closed losers, 2 troubled
 *      opens) versus 14 aligned entries realizing -3.32% themselves --
 *      directionally supportive, not a multi-day statistical proof. This
 *      check lives here (not in strategies.js's getEntry) for the same
 *      reason the EMA-cross exit does: getEntry stays the pure, reusable
 *      Darvas-box signal; this tracker is where real-world trading
 *      considerations layer on top of it. If EMA data isn't available yet
 *      (bars5 empty/not passed, e.g. a warm-up fetch failure for one
 *      symbol) this fails OPEN -- allows the entry rather than silently
 *      blocking a symbol from ever trading that day over a data outage.
 *   4. Entry gained a volume-spike filter 2026-07-29: a box breakout is
 *      suppressed if the entry brick's volume (the underlying 1-min
 *      candle's volume, same value renko.js stamps onto the brick) is
 *      >= VOLUME_SPIKE_THRESHOLD (6.0x) the trailing same-day 20-bar
 *      average 1-min volume. Root cause: the user spotted a recurring
 *      chart pattern across several losing trades -- an isolated, oversized
 *      volume print right at the breakout, with normal/thin volume on
 *      either side, rather than volume building steadily into the move.
 *      That signature (a single outsized print, not sustained elevated
 *      volume) usually means a one-off block/algo print clearing the book
 *      -- exhaustion, not the broad participation a genuine breakout needs.
 *      Verified against the real trade log (git branch
 *      data/darvasbox-shadow-0.25pct-1pctSL-trade-log, 62 analyzable
 *      trades across 2026-07-27..29): entries with a >=6x volume spike had
 *      a 14% win rate / -0.36% avg P&L versus 60-83% win rate for
 *      below-to-normal volume entries (Spearman correlation -0.345
 *      between spike ratio and P&L). Small sample (3 trading days) --
 *      treat 6.0x as a reasonable starting threshold, not a precisely
 *      tuned optimum. Same fail-OPEN philosophy as (3): fewer than
 *      VOLUME_MIN_TRAILING_BARS same-day prior bars (e.g. first few
 *      minutes of the session) allows the entry rather than blocking it.
 */

const { strategies } = require('./strategies');
const { istDateStr } = require('./bar_aggregator');
const darvas = strategies.find((s) => s.name === 'DarvasBox');
if (!darvas) throw new Error('DarvasBox strategy not found in strategies.js');

const EMA_FAST = 9;
const EMA_SLOW = 20;
const VOLUME_LOOKBACK_BARS = 20;
const VOLUME_MIN_TRAILING_BARS = 5;
const VOLUME_SPIKE_THRESHOLD = 6.0;

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

  /**
   * bricks = ALL of today's bricks so far (rebuilt fresh each poll). Entries
   * only -- see module docstring. bars5 = the SAME historical+today 5-min
   * bar series passed to checkEmaCrossExit (defaults to [] so callers that
   * don't care about the trend filter, e.g. existing unit tests, don't need
   * to supply it -- an empty/missing bars5 fails OPEN, see fork note (3)).
   * bars1m = today's raw 1-min bars (same array bricks were built from --
   * defaults to [] so the volume-spike filter fails OPEN too, see fork
   * note (4)). Returns new ENTRY events since the last call.
   */
  processBricks(bricks, bars5 = [], bars1m = []) {
    const ctx = { bricks };
    const events = [];
    const start = Math.max(1, this.processedBrickCount);
    const closes = bars5.map((b) => b.close);
    const emaFast = computeEma(closes, EMA_FAST);
    const emaSlow = computeEma(closes, EMA_SLOW);

    for (let i = start; i < bricks.length; i++) {
      if (!this.position) {
        const direction = darvas.getEntry(i, ctx);
        if (direction) {
          if (!this._trendAligned(direction, bricks[i].timestampMs, bars5, emaFast, emaSlow)) {
            continue;
          }
          if (!this._volumeSpikeOk(direction, bricks[i].timestampMs, bricks[i].volume, bars1m)) {
            continue;
          }
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

  /** True if EMA9/EMA20 (as of the last 5-min bar at/before brickTimestampMs) agree with `direction`, or if no EMA data is available at all (fails open -- see module docstring fork note 3). */
  _trendAligned(direction, brickTimestampMs, bars5, emaFast, emaSlow) {
    let idx = -1;
    for (let j = 0; j < bars5.length; j++) {
      if (bars5[j].timestampMs <= brickTimestampMs) idx = j; else break;
    }
    if (idx === -1 || emaFast[idx] == null || emaSlow[idx] == null) return true; // no EMA data yet -- fail open
    const aligned = direction === 'LONG' ? emaFast[idx] > emaSlow[idx] : emaFast[idx] < emaSlow[idx];
    if (!aligned) {
      console.log(`  [${this.symbol}] ${direction} box breakout at ${new Date(brickTimestampMs).toISOString()} suppressed -- EMA9 (${emaFast[idx].toFixed(3)}) vs EMA20 (${emaSlow[idx].toFixed(3)}) is counter-trend.`);
    }
    return aligned;
  }

  /**
   * True unless the entry brick's volume is an extreme spike relative to
   * the trailing same-day 1-min volume -- see module docstring fork note
   * (4). Fails OPEN (allows the entry) when bars1m is empty/not supplied,
   * when the entry bar can't be located in it, or when fewer than
   * VOLUME_MIN_TRAILING_BARS same-day bars precede it (e.g. the first few
   * minutes of the session) -- same philosophy as _trendAligned.
   */
  _volumeSpikeOk(direction, brickTimestampMs, brickVolume, bars1m) {
    if (!bars1m || bars1m.length === 0) return true;
    let idx = -1;
    for (let j = 0; j < bars1m.length; j++) {
      if (bars1m[j].timestampMs <= brickTimestampMs) idx = j; else break;
    }
    if (idx === -1) return true;

    const entryDate = istDateStr(bars1m[idx].timestampMs);
    const trailing = [];
    for (let j = idx - 1; j >= 0 && trailing.length < VOLUME_LOOKBACK_BARS; j--) {
      if (istDateStr(bars1m[j].timestampMs) !== entryDate) break;
      trailing.push(bars1m[j].volume);
    }
    if (trailing.length < VOLUME_MIN_TRAILING_BARS) return true;

    const trailingAvg = trailing.reduce((a, b) => a + b, 0) / trailing.length;
    if (trailingAvg <= 0) return true;

    const spikeRatio = brickVolume / trailingAvg;
    const ok = spikeRatio < VOLUME_SPIKE_THRESHOLD;
    if (!ok) {
      console.log(`  [${this.symbol}] ${direction} box breakout at ${new Date(brickTimestampMs).toISOString()} suppressed -- entry volume ${brickVolume} is ${spikeRatio.toFixed(1)}x the trailing ${trailing.length}-bar average (${trailingAvg.toFixed(1)}) -- extreme spike, likely exhaustion not confirmation.`);
    }
    return ok;
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
