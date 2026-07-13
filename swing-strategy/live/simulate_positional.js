'use strict';

/**
 * Positional trade simulator (multi-day hold), distinct from the intraday
 * simulateTrade used elsewhere in this project (minutes-based time-exit).
 * Entry executes at the NEXT DAY'S open after the signal candle (no
 * lookahead — the signal fires on today's close). Exit is whichever of
 * target/stop/time-cap comes first, walking forward day by day using Daily
 * OHLC. If both stop and target fall inside the same day's [low,high], the
 * stop is assumed to hit first (conservative convention — daily OHLC can't
 * tell us the real intraday order).
 *
 * MAX_HOLD_DAYS is a cap, not a target-style exit — the rulebook doesn't
 * specify a hold-time limit for a positional trade, but an unbounded hold
 * makes backtest P&L undefined for still-open trades. 90 trading days
 * (~4.5 months) is a reasonable outer bound for a swing setup meant to
 * resolve well before that.
 */

const MAX_HOLD_DAYS = 90;

function simulatePositionalTrade(dailyCandles, signalDayIndex, stopLoss, target) {
  const entryIdx = signalDayIndex + 1;
  if (entryIdx >= dailyCandles.length) return null; // no data to enter on
  const entryPrice = dailyCandles[entryIdx].open;

  for (let i = entryIdx; i < dailyCandles.length && i < entryIdx + MAX_HOLD_DAYS; i++) {
    const c = dailyCandles[i];
    const hitStop = c.low <= stopLoss;
    const hitTarget = c.high >= target;
    if (hitStop) {
      return {
        action: 'STOP_LOSS',
        exitPrice: stopLoss,
        exitDayIndex: i,
        holdDays: i - entryIdx,
        entryPrice,
        pnlPct: ((stopLoss - entryPrice) / entryPrice) * 100,
      };
    }
    if (hitTarget) {
      return {
        action: 'TARGET_HIT',
        exitPrice: target,
        exitDayIndex: i,
        holdDays: i - entryIdx,
        entryPrice,
        pnlPct: ((target - entryPrice) / entryPrice) * 100,
      };
    }
  }

  const capIdx = Math.min(entryIdx + MAX_HOLD_DAYS - 1, dailyCandles.length - 1);
  if (capIdx < entryIdx) return null;
  if (capIdx - entryIdx + 1 < MAX_HOLD_DAYS && capIdx === dailyCandles.length - 1) {
    // ran out of real data before the time cap
    const exitPrice = dailyCandles[capIdx].close;
    return {
      action: 'DATA_EXHAUSTED',
      exitPrice,
      exitDayIndex: capIdx,
      holdDays: capIdx - entryIdx,
      entryPrice,
      pnlPct: ((exitPrice - entryPrice) / entryPrice) * 100,
    };
  }
  const exitPrice = dailyCandles[capIdx].close;
  return {
    action: 'TIME_CAP',
    exitPrice,
    exitDayIndex: capIdx,
    holdDays: capIdx - entryIdx,
    entryPrice,
    pnlPct: ((exitPrice - entryPrice) / entryPrice) * 100,
  };
}

module.exports = { simulatePositionalTrade, MAX_HOLD_DAYS };
