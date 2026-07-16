'use strict';

/**
 * Diffs today's RS ranks against the persisted tracked-positions list.
 * Same alert-once-on-change convention as multibagger-screener: silent
 * unless a stock newly crosses the entry threshold or a held position
 * crosses the exit threshold.
 */

const RS_ENTRY_THRESHOLD = 80;
const RS_EXIT_THRESHOLD = 50;

/**
 * `todayRanks`: output of computeTodayRanks(). `tracked`: persisted state
 * (symbol -> {entryDate, entryPrice, rsRankAtEntry}), or {} on first run.
 * Returns { newCandidates, exits, updatedTracked }. `newCandidates` are
 * NOT yet added to updatedTracked -- the caller must do that only after
 * the Sales Growth gate passes (see server.js), since a candidate that
 * fails the fundamental check should not be tracked at all.
 */
function diffRsMomentum(todayRanks, tracked) {
  const newCandidates = [];
  const exits = [];
  const updatedTracked = { ...tracked };

  for (const [symbol, ranks] of Object.entries(todayRanks)) {
    const alreadyTracked = !!tracked[symbol];
    const { today, yesterday } = ranks;

    if (!alreadyTracked && yesterday && yesterday.rank < RS_ENTRY_THRESHOLD && today.rank >= RS_ENTRY_THRESHOLD) {
      newCandidates.push({ symbol, rsRankAtEntry: today.rank, price: ranks.currentPrice, date: today.date });
    } else if (alreadyTracked && today.rank < RS_EXIT_THRESHOLD) {
      exits.push({
        symbol,
        entryDate: tracked[symbol].entryDate,
        entryPrice: tracked[symbol].entryPrice,
        exitPrice: ranks.currentPrice,
        exitRsRank: today.rank,
        date: today.date,
        pnlPct: ((ranks.currentPrice - tracked[symbol].entryPrice) / tracked[symbol].entryPrice) * 100,
      });
      delete updatedTracked[symbol];
    }
  }

  return { newCandidates, exits, updatedTracked };
}

module.exports = { diffRsMomentum, RS_ENTRY_THRESHOLD, RS_EXIT_THRESHOLD };
