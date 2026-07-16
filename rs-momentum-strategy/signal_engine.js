'use strict';

/**
 * Entry detection: the first day a stock's RS percentile rank crosses from
 * below 80 to 80-or-above (a fresh crossing, not "still above 80 from
 * yesterday" — avoids re-signaling every day a stock just stays strong).
 */

const { isoDate } = require('./rs_rank');

const RS_ENTRY_THRESHOLD = 80;

/** dayCandles: Daily series. rankByDate: { dateStr: percentile(0-100) }. */
function findRsCrossingsAbove80(dayCandles, rankByDate) {
  const crossings = [];
  let prevRank = null;
  for (let i = 0; i < dayCandles.length; i++) {
    const date = isoDate(dayCandles[i].timestampMs);
    const rank = rankByDate[date];
    if (rank != null) {
      if (prevRank != null && prevRank < RS_ENTRY_THRESHOLD && rank >= RS_ENTRY_THRESHOLD) {
        crossings.push({ dayIdx: i, date, rsRank: rank });
      }
      prevRank = rank;
    }
  }
  return crossings;
}

module.exports = { findRsCrossingsAbove80, RS_ENTRY_THRESHOLD };
