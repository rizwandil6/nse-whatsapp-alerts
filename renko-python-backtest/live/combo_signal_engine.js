'use strict';

/**
 * Faithful port of ../signals.py's entry/exit state machine, resumable
 * incrementally one brick at a time (see renko_engine.js's docstring for
 * why "brick.runLength >= entryConfirmN" is exactly equivalent to
 * signals.py::detect_entry -- no rolling window needed).
 *
 * Exit logic ports signals.py::simulate_exit exactly: NO price-level stop
 * exists in this strategy at all (unlike DarvasBox's tracker in the
 * sibling live service) -- every exit is either a brick-confirmed reversal
 * (once "+1 brick profit" has been reached: at least one further confirmed
 * same-direction brick after entry) or a rejection-stoploss (sl_rejection_n
 * consecutive opposite bricks before reaching profit). See signals.py's
 * own docstring for the full reasoning/flagged ambiguity this reconciles.
 *
 * EOD square-off interaction with entry logic (NEW here -- the Python
 * backtest never had EOD close, so there's no batch behavior to match):
 * if forceEodClose fires mid-trend (the position's direction brick run is
 * still ongoing), the run counter is untouched by the close, so the very
 * next brick can immediately satisfy "runLength >= entryConfirmN" again
 * and re-enter right away. This is not a bug or special case -- it's the
 * literal, correct meaning of "N consecutive same-direction bricks" caught
 * fresh after any position closes; re-deriving detect_entry's semantics by
 * hand confirms this is exactly what the Python rule specifies, not an
 * artifact of adding EOD-close.
 */

class ComboTracker {
  constructor(comboId, entryConfirmN, slRejectionN) {
    this.comboId = comboId;
    this.entryConfirmN = entryConfirmN;
    this.slRejectionN = slRejectionN;
    this.position = null; // { direction: 'LONG'|'SHORT', entryPrice, entryTimestampMs }
    this.reachedProfit = false;
    this.consecutiveOpposite = 0;
  }

  /** Feeds one newly-formed brick (from the shared DynamicRenkoBuilder for this combo's brick_pct). Returns an ENTRY or EXIT event, or null. */
  onBrick(brick) {
    if (!this.position) {
      if (brick.runLength >= this.entryConfirmN) {
        const direction = brick.direction === 1 ? 'LONG' : 'SHORT';
        this.position = { direction, entryPrice: brick.close, entryTimestampMs: brick.timestampMs };
        this.reachedProfit = false;
        this.consecutiveOpposite = 0;
        return {
          type: 'ENTRY',
          comboId: this.comboId,
          direction,
          entry: brick.close,
          timestampMs: brick.timestampMs,
        };
      }
      return null;
    }

    const wantDir = this.position.direction === 'LONG' ? 1 : -1;
    if (brick.direction === wantDir) {
      this.consecutiveOpposite = 0;
      if (!this.reachedProfit) this.reachedProfit = true; // first continuation brick after entry = "+1 brick profit"
      return null;
    }

    // opposite-direction brick
    if (this.reachedProfit) {
      return this._close(brick.close, brick.timestampMs, 'REVERSAL_EXIT');
    }
    this.consecutiveOpposite += 1;
    if (this.consecutiveOpposite >= this.slRejectionN) {
      return this._close(brick.close, brick.timestampMs, 'SL_REJECTION');
    }
    return null;
  }

  /** Called at/after market close if a position is still open. Uses the current builder's last brick close/timestamp as the forced exit price/time. */
  forceEodClose(currentClose, currentTimestampMs) {
    if (!this.position) return null;
    return this._close(currentClose, currentTimestampMs, 'EOD_SQUARE_OFF');
  }

  _close(exitPrice, exitTimestampMs, action) {
    const pos = this.position;
    const pnlPoints = pos.direction === 'LONG' ? (exitPrice - pos.entryPrice) : (pos.entryPrice - exitPrice);
    const pnlPct = (pnlPoints / pos.entryPrice) * 100;
    this.position = null;
    this.reachedProfit = false;
    this.consecutiveOpposite = 0;
    return {
      type: 'EXIT',
      comboId: this.comboId,
      direction: pos.direction,
      entry: pos.entryPrice,
      exitPrice,
      action,
      pnlPct,
      pnlPoints,
      entryTimestampMs: pos.entryTimestampMs,
      exitTimestampMs,
    };
  }

  /** Serializable snapshot for state_store.js checkpointing. */
  toJSON() {
    return {
      position: this.position,
      reachedProfit: this.reachedProfit,
      consecutiveOpposite: this.consecutiveOpposite,
    };
  }

  static fromJSON(comboId, entryConfirmN, slRejectionN, snapshot) {
    const t = new ComboTracker(comboId, entryConfirmN, slRejectionN);
    if (snapshot) Object.assign(t, snapshot);
    return t;
  }
}

module.exports = { ComboTracker };
