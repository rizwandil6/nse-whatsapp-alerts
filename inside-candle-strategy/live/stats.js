'use strict';

/** Direction-aware P&L% for one trade -- same formula as CryptoForexService.java's
 *  attachPnlPct (dashboard), kept consistent so the Telegram number and the dashboard
 *  number never disagree for the same trade. */
function pnlPct(direction, entryPx, exitPx) {
  const entry = Number(entryPx), exit = Number(exitPx);
  if (!entry) return null;
  const pct = direction === 'LONG' ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
  return Math.round(pct * 100) / 100; // 2dp
}

/** Win rate + cumulative P&L% (naive sum, per-trade %, not compounded -- same convention as
 *  the dashboard's Swing tab "Cumulative P&L (naive sum)") over a set of closed trades. */
function computeStats(rows) {
  if (!rows || rows.length === 0) return { count: 0, winRate: null, cumPnlPct: null };
  let wins = 0, cum = 0;
  for (const row of rows) {
    const p = pnlPct(row.direction, row.entryPx, row.exitPx);
    if (p == null) continue;
    cum += p;
    const r = row.rMultiple != null ? Number(row.rMultiple) : p;
    if (r >= 0) wins++;
  }
  return {
    count: rows.length,
    winRate: Math.round((wins / rows.length) * 1000) / 10, // 1dp
    cumPnlPct: Math.round(cum * 100) / 100,
  };
}

module.exports = { pnlPct, computeStats };
