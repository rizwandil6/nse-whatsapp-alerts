'use strict';

/**
 * Incremental port of ../renko.py's DYNAMIC-mode brick construction (the
 * Python engine's default, config.FIXED_VS_DYNAMIC_PCT='dynamic' -- brick
 * size recomputed at EVERY brick as pct * last_brick_close, not fixed from
 * the first candle). This is NOT the same algorithm as this repo's sibling
 * renko-8-indicators/live/renko.js, which is fixed-brick-size and rebuilds
 * from scratch on every bar close -- neither would faithfully replicate
 * what the Python backtest validated.
 *
 * Why incremental (not "rebuild the whole history every 5 minutes"): the
 * Python backtest builds bricks over a symbol's ENTIRE history (potentially
 * a year+, thousands of bricks) as one continuous, never-reset series. This
 * live version must extend that same continuous series forever, so it
 * needs O(1) state per (symbol, brick_pct) -- {lastClose, direction,
 * runDirection, runLength} -- rather than an ever-growing array rebuilt
 * from scratch on every bar (which is what DarvasBox's live streamer does,
 * and only works there because it deliberately resets to "just today" once
 * a day).
 *
 * Faithfully mirrors renko.py::build_renko_bricks's inner while-loop,
 * including recomputing brick size on EVERY iteration of that loop (not
 * once per candle) -- this is the single easiest place a port could
 * silently diverge from dynamic mode. close-only price reference (no HL
 * mode -- that mode's ambiguity is disclosed in renko.py and not used by
 * the validated combo #1 anyway, config.USE_CLOSE_OR_HL='close').
 *
 * runLength/runDirection (attached to each emitted brick) is what lets
 * combo_signal_engine.js's entry check be a simple O(1) comparison instead
 * of re-scanning a rolling window: signals.py::detect_entry(bricks, i, N)
 * is true iff the run of same-direction bricks ending at i has length >= N
 * (trivially true for N=1, since a single-brick window is always "the same
 * direction as itself"; for N>1, since every new brick is checked exactly
 * once and a run's length only ever grows by 1 per brick, the first flat
 * check where runLength >= N necessarily happens exactly when runLength
 * first reaches N) -- so "brick.runLength >= entryConfirmN" is exactly
 * equivalent to detect_entry, no rolling window needed live.
 */

class DynamicRenkoBuilder {
  constructor(brickPct) {
    this.pct = brickPct / 100;
    this.lastClose = null;
    this.direction = 0; // 0 = none yet, 1 = up, -1 = down
    this.runDirection = 0;
    this.runLength = 0;
    this.lastBrickTimestampMs = null;
    this.seeded = false;
  }

  /** Feeds one candle's close (5-min bar close, matching config.USE_CLOSE_OR_HL='close'). Returns newly formed bricks (0, 1, or many on a big move). */
  pushCandleClose(close, timestampMs) {
    const bricks = [];
    if (!this.seeded) {
      // Matches renko.py: last_close seeded from the first candle's close; that
      // candle itself never forms a brick (price == last_close, zero distance).
      this.lastClose = close;
      this.seeded = true;
      return bricks;
    }

    const price = close;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const size = this.lastClose * this.pct; // dynamic: recomputed every loop iteration, not once per candle
      if (this.direction !== -1 && price >= this.lastClose + size) {
        bricks.push(this._formBrick(this.lastClose, this.lastClose + size, 1, timestampMs));
        continue;
      }
      if (this.direction !== 1 && price <= this.lastClose - size) {
        bricks.push(this._formBrick(this.lastClose, this.lastClose - size, -1, timestampMs));
        continue;
      }
      if (this.direction === 1 && price <= this.lastClose - 2 * size) {
        bricks.push(this._formBrick(this.lastClose, this.lastClose - size, -1, timestampMs));
        continue;
      }
      if (this.direction === -1 && price >= this.lastClose + 2 * size) {
        bricks.push(this._formBrick(this.lastClose, this.lastClose + size, 1, timestampMs));
        continue;
      }
      break;
    }
    return bricks;
  }

  /**
   * Dry-run check for real-time "early heads-up" alerts ONLY -- does NOT
   * mutate state, does NOT form an official brick. Official bricks still
   * only ever come from confirmed 5-min candle closes (pushCandleClose),
   * preserving exact parity with the validated backtest; this just answers
   * "if a tick at this price landed right now, would at least one brick
   * form?" so a fast notification can fire well before the candle
   * genuinely closes. Mirrors only the FIRST threshold check of the real
   * while-loop (whether multiple bricks would cascade doesn't matter for
   * an early-warning ping). Returns 1 (up), -1 (down), or null (no brick yet).
   */
  peekNextBrickDirection(price) {
    if (!this.seeded) return null;
    const size = this.lastClose * this.pct;
    if (this.direction !== -1 && price >= this.lastClose + size) return 1;
    if (this.direction !== 1 && price <= this.lastClose - size) return -1;
    if (this.direction === 1 && price <= this.lastClose - 2 * size) return -1;
    if (this.direction === -1 && price >= this.lastClose + 2 * size) return 1;
    return null;
  }

  _formBrick(open, close, direction, timestampMs) {
    this.lastClose = close;
    this.direction = direction;
    if (direction === this.runDirection) this.runLength += 1;
    else { this.runDirection = direction; this.runLength = 1; }
    this.lastBrickTimestampMs = timestampMs;
    return {
      open,
      close,
      direction, // 1 = up, -1 = down
      high: Math.max(open, close),
      low: Math.min(open, close),
      timestampMs,
      runLength: this.runLength, // length of the same-direction run ending at THIS brick
    };
  }

  /** Serializable snapshot for state_store.js checkpointing. */
  toJSON() {
    return {
      lastClose: this.lastClose,
      direction: this.direction,
      runDirection: this.runDirection,
      runLength: this.runLength,
      lastBrickTimestampMs: this.lastBrickTimestampMs,
      seeded: this.seeded,
    };
  }

  /** Restores state from a checkpoint written by toJSON(). */
  static fromJSON(brickPct, snapshot) {
    const b = new DynamicRenkoBuilder(brickPct);
    if (snapshot) Object.assign(b, snapshot);
    return b;
  }
}

module.exports = { DynamicRenkoBuilder };
