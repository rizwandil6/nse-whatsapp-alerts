'use strict';

/**
 * Simulates RS-momentum trades: enter at next day's open after an RS>=80
 * crossing (no lookahead), hold until RS rank drops below 50 (the
 * "character change from strong to weak" exit per the source, user-
 * confirmed threshold symmetric to the 80 entry) or a ~2-year max-hold
 * cap (500 trading days, matching the "1-2 year multibagger" framing) —
 * whichever comes first. No fixed price stop/target: this is a pure
 * relative-strength exit, per the source's own description. One position
 * per stock at a time — a crossing that occurs while already in a trade
 * from an earlier crossing is skipped.
 */

const { isoDate } = require('./rs_rank');

const RS_EXIT_THRESHOLD = 50;
const MAX_HOLD_DAYS = 500;

function simulateRsMomentumTrades(dayCandles, rankByDate, crossings) {
  const trades = [];
  let blockedUntilIdx = -1;

  for (const crossing of crossings) {
    if (crossing.dayIdx <= blockedUntilIdx) continue; // still in a position from an earlier entry
    const entryIdx = crossing.dayIdx + 1;
    if (entryIdx >= dayCandles.length) continue;
    const entry = dayCandles[entryIdx].open;

    let exitIdx = -1;
    let exitReason = null;
    let exitRank = null;
    for (let i = entryIdx; i < dayCandles.length && i < entryIdx + MAX_HOLD_DAYS; i++) {
      const date = isoDate(dayCandles[i].timestampMs);
      const rank = rankByDate[date];
      if (rank != null && rank < RS_EXIT_THRESHOLD) {
        exitIdx = i;
        exitReason = 'RS_WEAKNESS';
        exitRank = rank;
        break;
      }
    }
    if (exitIdx === -1) {
      exitIdx = Math.min(entryIdx + MAX_HOLD_DAYS - 1, dayCandles.length - 1);
      const ranOutOfData = exitIdx === dayCandles.length - 1 && exitIdx - entryIdx + 1 < MAX_HOLD_DAYS;
      exitReason = ranOutOfData ? 'DATA_EXHAUSTED' : 'MAX_HOLD_CAP';
    }

    const exitPrice = dayCandles[exitIdx].close;
    const pnlPct = ((exitPrice - entry) / entry) * 100;

    trades.push({
      entryDate: isoDate(dayCandles[entryIdx].timestampMs),
      entryIdx,
      entry,
      exitDate: isoDate(dayCandles[exitIdx].timestampMs),
      exitIdx,
      exitPrice,
      exitReason,
      exitRank,
      holdDays: exitIdx - entryIdx,
      pnlPct,
      rsRankAtEntry: crossing.rsRank,
    });
    blockedUntilIdx = exitIdx;
  }

  return trades;
}

module.exports = { simulateRsMomentumTrades, RS_EXIT_THRESHOLD, MAX_HOLD_DAYS };
