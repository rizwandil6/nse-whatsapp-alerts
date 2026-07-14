'use strict';

/**
 * Diffs TODAY'S BATCH results (not the whole universe — see
 * scan_multibagger.js's daily-rolling design) against the persisted
 * tracked-stocks list (git-committed JSON — Railway's Trial plan has no
 * persistent volumes, and this needs to survive indefinitely between runs).
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
 * Returns { newAlerts, lostAlerts, updatedTracked, logEntries }.
 *
 * `logEntries`: events for the PERMANENT append-only forward-performance
 * log (see forward_performance.js) — unlike `updatedTracked` (which
 * deletes a symbol once it loses qualification, since that's the active
 * list used for next run's diffing), the log keeps every qualification
 * and loss event forever, so real forward returns can be measured even
 * for stocks no longer actively tracked.
 */
function diffAndUpdate(scanResults, tracked) {
  const newAlerts = [];
  const lostAlerts = [];
  const logEntries = [];
  const updatedTracked = { ...tracked };
  const today = todayStr();

  for (const [symbol, r] of Object.entries(scanResults)) {
    const wasTracked = !!tracked[symbol];
    if (r.qualifies && !wasTracked) {
      updatedTracked[symbol] = {
        firstQualified: today,
        priceAtQualification: r.currentPrice ?? null, // for forward-return tracking — see forward_performance.js
        lastChecked: today,
        lastChecks: r.checks,
        lastData: r,
      };
      newAlerts.push({ symbol, data: r });
      logEntries.push({ type: 'QUALIFIED', symbol, date: today, price: r.currentPrice ?? null });
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
      logEntries.push({
        type: 'LOST',
        symbol,
        date: today,
        price: r.currentPrice ?? null,
        qualifiedDate: tracked[symbol].firstQualified,
        priceAtQualification: tracked[symbol].priceAtQualification ?? null,
      });
      delete updatedTracked[symbol];
    }
    // !r.qualifies && !wasTracked -> never qualified, still doesn't. Silent, no tracked entry.
  }

  return { newAlerts, lostAlerts, updatedTracked, logEntries };
}

module.exports = { diffAndUpdate, CHECK_LABELS };
