'use strict';

/**
 * A/B VARIANT tracker (added 2026-08-02): runs the SAME DarvasBox entry as
 * the real DarvasLiveTracker, plus two proposed changes, alongside it -- fed
 * the exact same live-built bricks/bars5 streamer.js already has. It NEVER
 * touches the real tracker's positions or the real trade log; it logs its own
 * ENTRY/EXIT events to a separate branch (see variant_log.js), purely to
 * observe how these two changes would have performed. Structurally isolated,
 * same discipline as shadow_dual_filter_tracker.js.
 *
 * The two changes vs. DarvasLiveTracker (everything else is deliberately
 * identical -- same getEntry, same _trendAligned + _volumeSpikeOk filters,
 * same LTP-at-confirmation fill, same forceEodClose -- so any difference in
 * outcome is attributable to exactly these two and nothing else):
 *
 *   1. ENTRY -- anti-chase gate. Forward analysis (2026-08-02, branch
 *      data/darvasbox-shadow-0.25pct-1pctSL) found that entries whose LIVE
 *      fill came in worse than the confirming brick's close by more than
 *      ~0.05-0.1% ("paid up" / chasing) won ~20% of the time (-0.5% avg) in
 *      both directions, while clean fills carried the whole edge. This gate
 *      skips a breakout when the live fill is worse than the brick close by
 *      more than MAX_ENTRY_CHASE_PCT. Fails OPEN when there's no live price
 *      (a theoretical fill has zero chase by definition) -- same fail-open
 *      philosophy as the existing two filters.
 *
 *   2. EXIT -- drop the 9/20 EMA-cross exit; replace with EOD square-off as
 *      the primary exit plus a WIDE catastrophic stop. A held-to-EOD
 *      reconstruction showed the EMA-cross exit was a net tax (holding beat
 *      it by +8.3pp across the 40 real EMA-cross trades). An exit-change
 *      backtest on the 124 real entries then showed EOD-only best and every
 *      stop a drag -- BUT that 4-day window had no gap/crash day, so it can't
 *      price the stop's tail-insurance value. So the stop is kept, but WIDE
 *      (CATASTROPHIC_STOP_PCT, 3.5% start): disasters only, never clips a
 *      winner. There is NO checkEmaCrossExit here.
 *
 * Restart safety: because entries fill at the live LTP (non-deterministic
 * across a replay), this tracker persists its open position exactly like the
 * real one (toJSON/restorePosition + variant_tracked_state.js) -- see
 * darvas_tracker.js's toJSON docstring for the real incident that motivated
 * it. Pure helpers (computeEma, emaAlignedAt, volumeSpikeCheck) and the
 * filter constants are imported from darvas_tracker.js, NOT reimplemented, so
 * the shared entry filters can never silently drift from the real tracker's.
 */

const { strategies } = require('./strategies');
const {
  emaAlignedAt, volumeSpikeCheck, computeEma, EMA_FAST, EMA_SLOW,
} = require('./darvas_tracker');

const darvas = strategies.find((s) => s.name === 'DarvasBox');
if (!darvas) throw new Error('DarvasBox strategy not found in strategies.js');

// Skip an entry whose live fill is worse than the confirming brick close by
// more than this (fraction). 0.10% is an in-sample starting point (the
// "paid-up" losing bucket began ~0.05%); tunable.
const MAX_ENTRY_CHASE_PCT = 0.0010;
// Wide catastrophic stop off the real entry price -- tail insurance only.
// 3.5% per the 2026-08-02 exit-change backtest (tight 1.5-2% stops shook out
// and backtested worse; wider is cheaper). Tunable; size from MAE if desired.
const CATASTROPHIC_STOP_PCT = 0.035;

class DarvasVariantTracker {
  constructor(symbol, getLivePriceFn) {
    this.symbol = symbol;
    this.getLivePriceFn = getLivePriceFn || (() => null);
    this.position = null;
    this.processedBrickCount = 0;
    this.processedBarCount = 0; // for checkCatastrophicStop's incremental scan
  }

  resetForNewDay() {
    this.position = null;
    this.processedBrickCount = 0;
    this.processedBarCount = 0;
  }

  _liveOrTheoretical(theoreticalPrice) {
    const live = this.getLivePriceFn();
    return { price: live != null ? live : theoreticalPrice, livePriceAvailable: live != null, theoreticalPrice };
  }

  /**
   * Entries only, same call shape as DarvasLiveTracker.processBricks. Adds
   * the anti-chase gate after the fill and sets a wide catastrophic stop on
   * the new position. Returns new variant ENTRY events since the last call.
   */
  processBricks(bricks, bars5 = [], entryBars = []) {
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
          if (!this._trendAligned(direction, bricks[i].timestampMs, bars5, emaFast, emaSlow)) continue;
          if (!this._volumeSpikeOk(direction, bricks[i].timestampMs, bricks[i].volume, entryBars)) continue;
          const theoreticalEntry = bricks[i].close;
          const { price: realEntry, livePriceAvailable } = this._liveOrTheoretical(theoreticalEntry);
          // CHANGE 1 -- anti-chase gate. Fails OPEN on a theoretical fill.
          if (livePriceAvailable && !this._chaseOk(direction, realEntry, theoreticalEntry, bricks[i].timestampMs)) continue;
          const stop = direction === 'LONG'
            ? realEntry * (1 - CATASTROPHIC_STOP_PCT)
            : realEntry * (1 + CATASTROPHIC_STOP_PCT);
          this.position = { direction, entry: realEntry, entryIdx: i, entryTimestampMs: bricks[i].timestampMs, stop };
          events.push({
            type: 'ENTRY', symbol: this.symbol, direction, entry: realEntry, theoreticalEntry, stop,
            entryIdx: i, timestampMs: bricks[i].timestampMs, livePriceAvailable, variant: true,
          });
        }
      }
    }
    this.processedBrickCount = bricks.length;
    return events;
  }

  /** True if EMA9/EMA20 (as of the last 5-min bar at/before brickTimestampMs) agree with `direction`, or no EMA data yet (fails open) -- identical to DarvasLiveTracker._trendAligned. */
  _trendAligned(direction, brickTimestampMs, bars5, emaFast, emaSlow) {
    const { aligned, hasData } = emaAlignedAt(direction, brickTimestampMs, bars5, emaFast, emaSlow);
    return hasData ? aligned : true;
  }

  /** True unless the entry brick's volume is an extreme spike vs the trailing same-day average -- identical to DarvasLiveTracker._volumeSpikeOk. Fails open. */
  _volumeSpikeOk(direction, brickTimestampMs, brickVolume, entryBars) {
    return volumeSpikeCheck(brickTimestampMs, brickVolume, entryBars).ok;
  }

  /**
   * CHANGE 1. False (skip) when the live fill is worse than the brick close
   * (paid up / chasing) by more than MAX_ENTRY_CHASE_PCT. `chase` > 0 means
   * a worse fill: for LONG, filled above the brick close; for SHORT, below.
   */
  _chaseOk(direction, realEntry, theoreticalEntry, brickTimestampMs) {
    const chase = direction === 'LONG'
      ? (realEntry - theoreticalEntry) / theoreticalEntry
      : (theoreticalEntry - realEntry) / theoreticalEntry;
    if (chase > MAX_ENTRY_CHASE_PCT) {
      console.log(`  [variant ${this.symbol}] ${direction} breakout suppressed -- live fill ${realEntry} is ${(chase * 100).toFixed(2)}% past brick close ${theoreticalEntry.toFixed(2)} (chasing).`);
      return false;
    }
    return true;
  }

  /**
   * CHANGE 2 (part). Wide catastrophic stop, checked against real 1-min bar
   * lows/highs (the finest granularity available -- a catastrophic stop wants
   * the fastest detection). Touch-based, adapted from the pre-2026-07-28
   * checkIntrabarStop; no trailing branch (there is no trailing stop here).
   * Only bars strictly after the entry bar are eligible, same reason as the
   * original: an entry-or-earlier bar's low/high can't be trusted to postdate
   * the entry signal. Call AFTER processBricks each poll, feeding the raw
   * 1-min bars.
   */
  checkCatastrophicStop(bars) {
    const start = this.processedBarCount;
    this.processedBarCount = bars.length;
    if (!this.position) return null;
    const pos = this.position;
    for (let i = start; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.timestampMs <= pos.entryTimestampMs) continue;
      const hit = pos.direction === 'LONG' ? bar.low <= pos.stop : bar.high >= pos.stop;
      if (hit) {
        const pnlPct = pos.direction === 'LONG'
          ? ((pos.stop - pos.entry) / pos.entry) * 100
          : ((pos.entry - pos.stop) / pos.entry) * 100;
        this.position = null;
        return {
          type: 'EXIT', symbol: this.symbol, direction: pos.direction, entry: pos.entry,
          exitPrice: pos.stop, action: 'CATASTROPHIC_STOP', barsHeld: null, pnlPct,
          entryTimestampMs: pos.entryTimestampMs, exitTimestampMs: bar.timestampMs, variant: true,
        };
      }
    }
    return null;
  }

  /** CHANGE 2 (part). EOD square-off -- identical rule to DarvasLiveTracker.forceEodClose (LTP at 15:30, falling back to the brick close). */
  forceEodClose(bricks) {
    if (!this.position || bricks.length === 0) return null;
    const last = bricks[bricks.length - 1];
    const { price: realExit, livePriceAvailable } = this._liveOrTheoretical(last.close);
    const pos = this.position;
    const pnlPct = pos.direction === 'LONG'
      ? ((realExit - pos.entry) / pos.entry) * 100
      : ((pos.entry - realExit) / pos.entry) * 100;
    this.position = null;
    return {
      type: 'EXIT', symbol: this.symbol, direction: pos.direction, theoreticalExit: last.close,
      livePriceAvailable, entry: pos.entry, exitPrice: realExit, action: 'EOD_SQUARE_OFF',
      barsHeld: pos.entryIdx != null ? (bricks.length - 1) - pos.entryIdx : null, pnlPct,
      entryTimestampMs: pos.entryTimestampMs, exitTimestampMs: last.timestampMs, variant: true,
    };
  }

  // Restart safety -- persist the open position (incl. its stop) exactly like
  // the real tracker; entryIdx is dropped on restore since a rebuilt bricks
  // array no longer lines up (see darvas_tracker.js _close/restorePosition).
  toJSON() {
    return { position: this.position };
  }

  restorePosition(json) {
    if (json && json.position) {
      this.position = { ...json.position, entryIdx: null };
    }
  }
}

module.exports = { DarvasVariantTracker, MAX_ENTRY_CHASE_PCT, CATASTROPHIC_STOP_PCT };
