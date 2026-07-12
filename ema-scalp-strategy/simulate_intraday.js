'use strict';

/**
 * Same-day intraday simulator, adapted from box-strategy/simulate_intraday.js.
 * Time cutoff 15:20 IST. Stop assumed to hit first if both stop and target
 * fall in the same bar's range (conservative convention used throughout
 * this project).
 */

const IST_OFFSET_MS = 5.5 * 3600000;
function istMinutesSinceMidnight(ms) {
  const shifted = new Date(ms + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}
const TIME_CUTOFF_MINUTES = 15 * 60 + 20;

function simulateTrade(dayCandles, signal) {
  const { direction, entryIdx, entryPrice, stopLoss, target } = signal;
  if (entryIdx >= dayCandles.length) return null;

  for (let i = entryIdx; i < dayCandles.length; i++) {
    const c = dayCandles[i];
    const pastCutoff = istMinutesSinceMidnight(c.timestampMs) >= TIME_CUTOFF_MINUTES;

    if (direction === 'LONG') {
      if (c.low <= stopLoss) return finish('STOP_LOSS', stopLoss, i, entryIdx, entryPrice, direction);
      if (c.high >= target) return finish('TARGET_HIT', target, i, entryIdx, entryPrice, direction);
    } else {
      if (c.high >= stopLoss) return finish('STOP_LOSS', stopLoss, i, entryIdx, entryPrice, direction);
      if (c.low <= target) return finish('TARGET_HIT', target, i, entryIdx, entryPrice, direction);
    }
    if (pastCutoff) return finish('TIME_EXIT', c.close, i, entryIdx, entryPrice, direction);
  }
  const last = dayCandles[dayCandles.length - 1];
  return finish('DATA_EXHAUSTED', last.close, dayCandles.length - 1, entryIdx, entryPrice, direction);
}

function finish(action, exitPrice, exitIdx, entryIdx, entryPrice, direction) {
  const pnlPct = direction === 'LONG' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
  return { action, exitPrice, exitIdx, barsHeld: exitIdx - entryIdx, entryPrice, pnlPct };
}

module.exports = { simulateTrade, TIME_CUTOFF_MINUTES };
