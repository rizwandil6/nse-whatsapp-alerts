'use strict';

/**
 * Diffs this run's scan results against the persisted tracked-stocks list
 * (git-committed JSON — see README for why: Railway's Trial plan has no
 * persistent volumes, and this needs to survive a full month between runs).
 *
 * Three outcomes per stock:
 *   - NEW: qualifies now, wasn't tracked before -> "new candidate" alert.
 *   - LOST: was tracked, doesn't qualify now -> "lost qualification" alert,
 *     with a diff of exactly which check(s) flipped to failing, including
 *     halal-compliance loss specifically flagged as its own case (agreed
 *     directly: halal loss fires the same alert type as a parameter loss).
 *   - UNCHANGED (still qualifying, or never qualified): silent, matching
 *     the agreed alert-once semantics — no repeat "still qualifies" noise.
 */

const CHECK_LABELS = {
  halalBusiness: 'Halal business type',
  halalDebt: 'Halal debt-to-assets < 33%',
  marketCapCr: 'Market Cap > Rs 1,000 Cr',
  peg: 'PEG < 1',
  peVsIndustry: 'PE < Sector-average PE',
  roe: 'ROE > 20%',
  roce: 'ROCE > 15%',
  debtToEquity: 'Debt/Equity < 0.5',
  promoterPct: 'Promoter holding > 50%',
  salesGrowth3Y: 'Sales Growth 3Y > 15%',
  profitGrowth5Y: 'Profit Growth 5Y > 15%',
  opmPct: 'OPM > 15%',
  priceToSales: 'Price/Sales < 10',
  evToEbitda: 'EV/EBITDA < 25',
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `scanResults`: output of scan_multibagger.js (symbol -> {qualifies, checks, ...fundamentals}).
 * `tracked`: previous persisted state (symbol -> {firstQualified, lastChecks, lastData}), or {} on first run.
 * Returns { newAlerts, lostAlerts, updatedTracked }.
 */
function diffAndUpdate(scanResults, tracked) {
  const newAlerts = [];
  const lostAlerts = [];
  const updatedTracked = { ...tracked };
  const today = todayStr();

  for (const [symbol, r] of Object.entries(scanResults)) {
    const wasTracked = !!tracked[symbol];
    if (r.qualifies && !wasTracked) {
      updatedTracked[symbol] = { firstQualified: today, lastChecked: today, lastChecks: r.checks, lastData: r };
      newAlerts.push({ symbol, data: r });
    } else if (r.qualifies && wasTracked) {
      updatedTracked[symbol] = { ...tracked[symbol], lastChecked: today, lastChecks: r.checks, lastData: r };
    } else if (!r.qualifies && wasTracked) {
      const prevChecks = tracked[symbol].lastChecks || {};
      const failedNow = Object.entries(r.checks)
        .filter(([key, passed]) => !passed)
        .map(([key]) => ({
          key,
          label: CHECK_LABELS[key] || key,
          wasPassingBefore: prevChecks[key] === true,
          isHalal: key === 'halalBusiness' || key === 'halalDebt',
        }));
      lostAlerts.push({
        symbol,
        firstQualified: tracked[symbol].firstQualified,
        failedChecks: failedNow,
        currentData: r,
        previousData: tracked[symbol].lastData,
      });
      delete updatedTracked[symbol];
    }
    // !r.qualifies && !wasTracked -> never qualified, still doesn't. Silent, no tracked entry.
  }

  return { newAlerts, lostAlerts, updatedTracked };
}

module.exports = { diffAndUpdate, CHECK_LABELS };
