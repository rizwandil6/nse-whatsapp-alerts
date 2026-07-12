'use strict';

/**
 * Incremental, per-symbol signal + outcome tracker for live streaming.
 * Reuses the exact same, already-validated logic as the backtest and
 * shadow-trade scripts — findDaySignalShortBigBarOnly (signals.js) for
 * detection, and the same stop/target/cutoff priority as
 * simulate_intraday.js's simulateTrade — just fed one new bar at a time
 * instead of a complete static array.
 */

const { findDaySignalShortBigBarOnly } = require('./signals');
const IST_OFFSET_MS = 5.5 * 3600000;
const TIME_CUTOFF_MINUTES = 15 * 60 + 20;

function istMinutesSinceMidnight(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

const CAPITAL = 100000;
function transactionCostPct(entryPrice, exitPrice, direction) {
  const qty = CAPITAL / entryPrice;
  const entryValue = qty * entryPrice, exitValue = qty * exitPrice;
  const buyValue = direction === 'LONG' ? entryValue : exitValue;
  const sellValue = direction === 'LONG' ? exitValue : entryValue;
  const brokerage = Math.min(20, buyValue * 0.0003) + Math.min(20, sellValue * 0.0003);
  const stt = sellValue * 0.00025;
  const exchangeTxnCharges = (buyValue + sellValue) * 0.0000297;
  const sebiCharges = (buyValue + sellValue) * 0.000001;
  const stampDuty = buyValue * 0.00003;
  const gst = 0.18 * (brokerage + exchangeTxnCharges + sebiCharges);
  return ((brokerage + stt + exchangeTxnCharges + sebiCharges + stampDuty + gst) / CAPITAL) * 100;
}

/**
 * One instance per symbol per trading day. Call onNewBar() every time a
 * new 5-min bar completes for this symbol (via BarAggregator). Call
 * getNiftyCandles() to fetch Nifty's up-to-date 5-min series for the
 * cross-confirmation check.
 */
class LiveSymbolTracker {
  constructor(symbol, getNiftyCandles) {
    this.symbol = symbol;
    this.getNiftyCandles = getNiftyCandles;
    this.candles5m = [];
    this.signal = null; // {direction, pattern, entryIdx, entryPrice, stopLoss, target}
    this.outcome = null; // {action, exitPrice, exitIdx, pnlPct, costPct, netPnlPct}
    this.checkedUpToIdx = -1; // last bar index already checked for stop/target/cutoff
    this.signalEvents = []; // collected events to emit: {type: 'SIGNAL'|'OUTCOME', ...}
  }

  /** Returns an array of newly-produced events (signal fired / outcome resolved) for this call. */
  onNewBar(bar) {
    this.candles5m.push(bar);
    const events = [];

    if (!this.signal) {
      const niftyCandles = this.getNiftyCandles();
      const sig = findDaySignalShortBigBarOnly(this.candles5m, niftyCandles);
      if (sig) {
        this.signal = sig;
        this.checkedUpToIdx = sig.entryIdx - 1; // start checking from the entry bar itself
        events.push({ type: 'SIGNAL', symbol: this.symbol, ...sig });
      }
    }

    if (this.signal && !this.outcome) {
      for (let i = this.checkedUpToIdx + 1; i < this.candles5m.length; i++) {
        const c = this.candles5m[i];
        const pastCutoff = istMinutesSinceMidnight(c.timestampMs) >= TIME_CUTOFF_MINUTES;
        let action = null, exitPrice = null;
        if (c.high >= this.signal.stopLoss) { action = 'STOP_LOSS'; exitPrice = this.signal.stopLoss; }
        else if (c.low <= this.signal.target) { action = 'TARGET_HIT'; exitPrice = this.signal.target; }
        else if (pastCutoff) { action = 'TIME_EXIT'; exitPrice = c.close; }

        this.checkedUpToIdx = i;

        if (action) {
          const pnlPct = ((this.signal.entryPrice - exitPrice) / this.signal.entryPrice) * 100;
          const costPct = transactionCostPct(this.signal.entryPrice, exitPrice, this.signal.direction);
          this.outcome = { action, exitPrice, exitIdx: i, barsHeld: i - this.signal.entryIdx, pnlPct, costPct, netPnlPct: pnlPct - costPct };
          events.push({ type: 'OUTCOME', symbol: this.symbol, ...this.outcome, signal: this.signal });
          break;
        }
      }
    }

    return events;
  }

  /** Call once at end of day if a signal fired but never resolved (shouldn't normally happen given the 15:20 cutoff check, but a safety net for a short/gapped data day). */
  forceEndOfDay() {
    if (this.signal && !this.outcome && this.candles5m.length > this.signal.entryIdx) {
      const last = this.candles5m[this.candles5m.length - 1];
      const pnlPct = ((this.signal.entryPrice - last.close) / this.signal.entryPrice) * 100;
      const costPct = transactionCostPct(this.signal.entryPrice, last.close, this.signal.direction);
      this.outcome = { action: 'DATA_EXHAUSTED', exitPrice: last.close, exitIdx: this.candles5m.length - 1, barsHeld: this.candles5m.length - 1 - this.signal.entryIdx, pnlPct, costPct, netPnlPct: pnlPct - costPct };
      return [{ type: 'OUTCOME', symbol: this.symbol, ...this.outcome, signal: this.signal }];
    }
    return [];
  }
}

module.exports = { LiveSymbolTracker, transactionCostPct };
