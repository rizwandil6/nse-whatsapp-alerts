'use strict';

/**
 * Cross-symbol daily risk gate for the REAL-MONEY DarvasBox live trade.
 * Tracks realized rupee P&L across every symbol for the current trading
 * day; once cumulative realized loss crosses DAILY_MAX_LOSS_RS, new
 * entries are blocked for the rest of the day (existing open positions
 * still get their normal exit checks -- this only gates NEW entries, it
 * doesn't itself force-close anything; streamer.js's circuit-breaker
 * square-off sweep is what actually closes positions once tripped).
 *
 * Deliberately a single process-wide gate, not per-symbol -- the whole
 * point of a daily loss limit is bounding total capital at risk across
 * the account for the day, not per name.
 */

class RiskManager {
  constructor(dailyMaxLossRs) {
    this.dailyMaxLossRs = dailyMaxLossRs;
    this.realizedPnlRs = 0;
    this.tripped = false;
    this.trippedReason = null;
  }

  resetForNewDay() {
    this.realizedPnlRs = 0;
    this.tripped = false;
    this.trippedReason = null;
  }

  /** Call after every real EXIT fill (not on entry). Trips the breaker if the daily loss limit is now breached. */
  recordRealizedPnl(pnlRs) {
    this.realizedPnlRs += pnlRs;
    if (!this.tripped && this.realizedPnlRs <= -Math.abs(this.dailyMaxLossRs)) {
      this.tripped = true;
      this.trippedReason = `Daily realized loss ₹${Math.abs(this.realizedPnlRs).toFixed(0)} reached the ₹${Math.abs(this.dailyMaxLossRs).toFixed(0)} limit`;
    }
    return this.tripped;
  }

  /** New entries are only allowed while the breaker hasn't tripped. */
  canEnter() {
    return !this.tripped;
  }
}

module.exports = { RiskManager };
