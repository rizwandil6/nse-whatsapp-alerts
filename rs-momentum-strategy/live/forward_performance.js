'use strict';

/**
 * Forward performance since alert -- "how did the stock actually do after
 * we flagged it", shown on the dashboard. Deliberately reuses the SAME
 * universe data server.js already fetches fresh every run (fetchUniverse's
 * bySymbol, ~354 stocks incl. every symbol this log has ever mentioned,
 * since a symbol can only appear here after being ranked from that same
 * universe) -- no extra Upstox calls needed, unlike multibagger-screener's
 * equivalent (which needs a dedicated Screener.in fetch since its universe
 * data doesn't carry price).
 *
 * One summary row per symbol (its most recent ENTRY episode): current
 * price = universe's latest daily close. If a later EXIT exists, also
 * reports the realized return while the position was actually open
 * (reusing the EXIT event's own logged pnlPct, not recomputed) alongside
 * the return since entry INCLUDING any drift after exit -- same "both
 * numbers" shape as multibagger-screener's forward_performance.js for
 * qualification-loss, so the two tabs read consistently.
 */

function computeForwardPerformance(log, universeBySymbol) {
  const bySymbol = {};
  for (const entry of log) {
    if (!bySymbol[entry.symbol]) bySymbol[entry.symbol] = [];
    bySymbol[entry.symbol].push(entry);
  }

  const summaries = [];
  for (const [symbol, events] of Object.entries(bySymbol)) {
    const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
    const lastEntry = [...sorted].reverse().find((e) => e.type === 'ENTRY');
    if (!lastEntry) continue;
    const exitAfter = sorted.find((e) => e.type === 'EXIT' && e.date >= lastEntry.date);

    const candles = universeBySymbol[symbol];
    const currentPrice = candles && candles.length ? candles[candles.length - 1].close : null;
    const returnSinceEntry =
      currentPrice != null && lastEntry.price ? ((currentPrice - lastEntry.price) / lastEntry.price) * 100 : null;

    summaries.push({
      symbol,
      entryDate: lastEntry.date,
      entryPrice: lastEntry.price,
      status: exitAfter ? 'closed' : 'open',
      exitDate: exitAfter ? exitAfter.date : null,
      exitPrice: exitAfter ? exitAfter.price : null,
      returnWhileOpen: exitAfter ? exitAfter.pnlPct : null, // reuses the EXIT event's own logged P&L, not recomputed
      currentPrice,
      returnSinceEntry, // includes any drift after exit, for closed positions -- same convention as multibagger's returnSinceQualification
    });
  }

  summaries.sort((a, b) => b.entryDate.localeCompare(a.entryDate));
  return summaries;
}

module.exports = { computeForwardPerformance };
