'use strict';

/**
 * Shadow experiment (added 2026-08-01): runs a proposed dual-EMA
 * (candle-based AND brick-based) + volume-spike "pending confirmation"
 * entry filter alongside the REAL DarvasLiveTracker, fed the exact same
 * live-built bricks/bars5 streamer.js already has for the real tracker --
 * no separate data reconstruction, so none of the Renko path-dependency
 * drift that made a one-off historical backtest unreliable (2026-07-31:
 * ~40% of a week's real trades couldn't even be matched up against a
 * rebuilt brick series). This tracker NEVER touches real positions or the
 * real trade log -- it only produces its OWN shadow ENTRY/EXIT events,
 * logged separately (see shadow_log.js), purely to observe what this
 * filter design would have done if it had been live.
 *
 * Background (full discussion 2026-07-31, DarvasBox chat): the real
 * tracker's existing trend filter (_trendAligned) only checks EMA9/EMA20
 * on 5-min CANDLES at the moment of a box breakout. Reviewing real charts
 * that day found cases where candle-EMA had already flipped "aligned" a
 * beat before brick-EMA (computed on the same Renko bricks the breakout
 * itself is measured against) agreed -- e.g. TITAGARH's SHORT entry at
 * 824.25 (10:20 IST) passed candle-EMA by only 0.08 points while
 * brick-EMA was still clearly counter-trend. Adding a bare "require
 * brick-EMA too" filter, evaluated only once at the breakout brick,
 * would have blocked 7 of 11 real trades that day outright -- because a
 * Darvas box "spends" itself the instant the breakout brick prints
 * (see strategies.js's computeConfirmedBoxSeries) and needs a fresh
 * 3-bar consolidation to re-arm, which is unrelated to whether EMA has
 * caught up and rarely happens again same-day. The PENDING-CONFIRMATION
 * design here keeps the original breakout level "alive" (independent of
 * the box-spent mechanic) for as long as price stays beyond it,
 * re-checking all three filters fresh on every subsequent brick,
 * entering the moment all three agree simultaneously, and discarding the
 * setup only if price reverts back inside the level. A historical
 * backtest of this exact design (built from reconstructed, NOT live,
 * bricks) showed JSWINFRA's SHORT -- which a bare one-shot filter would
 * have missed entirely -- getting rescued 5 minutes later at a smaller
 * but still profitable price, and correctly rejected several trades that
 * went on to lose. Running the real thing live (this tracker) is the
 * only way to validate that without reconstruction-drift noise.
 *
 * Volume-spike and candle-EMA checks are reused directly from
 * darvas_tracker.js's exported pure helpers (volumeSpikeCheck,
 * emaAlignedAt) -- NOT reimplemented here, so this can never silently
 * drift from what the real tracker's own filters actually do. Brick-EMA
 * uses the SAME emaAlignedAt helper, just fed the brick series instead
 * of bars5.
 */

const { strategies, confirmedBoxAt } = require('./strategies');
const { computeEma, emaAlignedAt, volumeSpikeCheck, EMA_FAST, EMA_SLOW } = require('./darvas_tracker');

const darvas = strategies.find((s) => s.name === 'DarvasBox');
if (!darvas) throw new Error('DarvasBox strategy not found in strategies.js');

class ShadowDualFilterTracker {
  constructor(symbol) {
    this.symbol = symbol;
    this.pending = null; // { direction, level, breakoutTimestampMs }
    this.position = null; // { direction, entry, entryTimestampMs, breakoutTimestampMs }
    this.processedBrickCount = 0;
    this.processedBar5Count = 0;
  }

  resetForNewDay() {
    this.pending = null;
    this.position = null;
    this.processedBrickCount = 0;
    this.processedBar5Count = 0;
  }

  /**
   * Entry side. Same call shape as DarvasLiveTracker.processBricks
   * (bricks/bars5/entryBars rebuilt fresh every poll, entries only).
   * Replaces the real tracker's one-shot box-spend check with the
   * pending-confirmation state machine described in the module docstring.
   * Returns new shadow ENTRY events since the last call.
   */
  processBricks(bricks, bars5 = [], entryBars = []) {
    const ctx = { bricks };
    const events = [];
    const closes5 = bars5.map((b) => b.close);
    const emaFast5 = computeEma(closes5, EMA_FAST);
    const emaSlow5 = computeEma(closes5, EMA_SLOW);
    const closesB = bricks.map((b) => b.close);
    const emaFastB = computeEma(closesB, EMA_FAST);
    const emaSlowB = computeEma(closesB, EMA_SLOW);

    const start = Math.max(1, this.processedBrickCount);
    for (let i = start; i < bricks.length; i++) {
      if (this.position) continue; // one shadow position at a time, same as the real tracker

      if (this.pending) {
        const stillBeyond = this.pending.direction === 'LONG'
          ? bricks[i].close > this.pending.level
          : bricks[i].close < this.pending.level;
        if (!stillBeyond) {
          this.pending = null; // price reverted inside the level -- setup discarded, not retried
          continue;
        }
      } else {
        const direction = darvas.getEntry(i, ctx);
        if (!direction) continue;
        const box = confirmedBoxAt(i, ctx);
        if (!box) continue; // defensive -- getEntry firing implies a box was active
        const level = direction === 'LONG' ? box.top : box.bottom;
        this.pending = { direction, level, breakoutTimestampMs: bricks[i].timestampMs };
      }

      const { direction } = this.pending;
      const candleCheck = emaAlignedAt(direction, bricks[i].timestampMs, bars5, emaFast5, emaSlow5);
      if (!candleCheck.aligned) continue;
      const brickCheck = emaAlignedAt(direction, bricks[i].timestampMs, bricks, emaFastB, emaSlowB);
      if (!brickCheck.aligned) continue;
      const volCheck = volumeSpikeCheck(bricks[i].timestampMs, bricks[i].volume, entryBars);
      if (!volCheck.ok) continue;

      const breakoutTimestampMs = this.pending.breakoutTimestampMs;
      this.position = { direction, entry: bricks[i].close, entryTimestampMs: bricks[i].timestampMs, breakoutTimestampMs };
      this.pending = null;
      events.push({
        type: 'ENTRY', symbol: this.symbol, direction, entry: bricks[i].close,
        timestampMs: bricks[i].timestampMs, breakoutTimestampMs, shadow: true,
      });
    }
    this.processedBrickCount = bricks.length;
    return events;
  }

  /**
   * Exit side -- deliberately IDENTICAL rule to the real tracker (9/20 EMA
   * cross on 5-min bars). This experiment is only testing the entry-side
   * dual filter; changing the exit too would make it impossible to tell
   * which change caused any difference in outcome.
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
        const pnlPct = pos.direction === 'LONG'
          ? ((bars5[i].close - pos.entry) / pos.entry) * 100
          : ((pos.entry - bars5[i].close) / pos.entry) * 100;
        this.position = null;
        return {
          type: 'EXIT', symbol: this.symbol, direction: pos.direction, entry: pos.entry,
          exitPrice: bars5[i].close, action: 'EMA_9_20_CROSS', pnlPct,
          entryTimestampMs: pos.entryTimestampMs, exitTimestampMs: bars5[i].timestampMs, shadow: true,
        };
      }
    }
    return null;
  }

  /** Mirrors DarvasLiveTracker.forceEodClose -- same EOD square-off rule. */
  forceEodClose(bricks) {
    if (!this.position || bricks.length === 0) return null;
    const last = bricks[bricks.length - 1];
    const pos = this.position;
    const pnlPct = pos.direction === 'LONG'
      ? ((last.close - pos.entry) / pos.entry) * 100
      : ((pos.entry - last.close) / pos.entry) * 100;
    this.position = null;
    return {
      type: 'EXIT', symbol: this.symbol, direction: pos.direction, entry: pos.entry,
      exitPrice: last.close, action: 'EOD_SQUARE_OFF', pnlPct,
      entryTimestampMs: pos.entryTimestampMs, exitTimestampMs: last.timestampMs, shadow: true,
    };
  }
}

module.exports = { ShadowDualFilterTracker };
