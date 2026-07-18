'use strict';

/**
 * Daily rolling multibagger scan — redesigned from an original monthly
 * full-batch design after direct feedback: scanning all ~2,052 stocks in
 * one sitting takes hours and is a real rate-limit risk against
 * Screener.in. Instead, ~100 stocks/day (see server.js for the cursor that
 * picks which 100), so the full universe cycles roughly every ~21 days —
 * continuous rolling freshness instead of one big monthly burst, and each
 * day's run only takes minutes.
 *
 * `all_results.json` is a PERSISTENT, git-committed store (not
 * regenerated from scratch each run) — every stock's most recent scan
 * result lives here indefinitely, updated incrementally as its turn comes
 * up in the rolling cycle. On any given day, most of the universe's data
 * is up to ~21 days old and a small slice (today's batch) is fresh.
 *
 * Threshold checks — MISSING DATA CONVENTION: if a required parameter
 * can't be computed (scrape failure, or a divide-by-zero in a derived
 * metric like PEG), that check is treated as NOT SATISFIED, not
 * pass-through — the one deliberate exception is `pledgePct`, which is
 * always unavailable (see fundamental_screener.js) and is excluded from
 * the requirement entirely, per direct agreement.
 *
 * Industry PE substitute: average PE across ALL stocks currently in
 * `all_results.json` sharing the same Screener.in "Sector" tag (a mix of
 * today's-fresh and up-to-21-days-old data — accepted approximation, PE
 * doesn't move wildly day to day for most stocks). Qualification is only
 * RECOMPUTED for today's batch, not the whole store, so a stock's
 * qualification status only changes when ITS OWN data is refreshed —
 * avoids noisy state flips driven by small day-to-day sector-average
 * drift rather than a real change in the stock's own fundamentals.
 */

const fs = require('fs');
const path = require('path');
const { fetchFundamentals } = require('./fundamental_screener');

const ALL_RESULTS_PATH = path.join(__dirname, 'all_results.json');
const BATCH_CHECKPOINT_PATH = path.join(__dirname, 'batch_checkpoint.json');
const FETCH_DELAY_MS = parseInt(process.env.FETCH_DELAY_MS || '300', 10);

const THRESHOLDS = {
  marketCapCr: { min: 1000 },
  peg: { max: 1 },
  roe: { min: 20 },
  roce: { min: 15 },
  debtToEquity: { max: 0.5 },
  promoterPct: { min: 50 },
  salesGrowth3Y: { min: 15 },
  profitGrowth5Y: { min: 15 },
  opmPct: { min: 15 },
  priceToSales: { max: 10 },
  evToEbitda: { max: 25 },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadAllResults() {
  return fs.existsSync(ALL_RESULTS_PATH) ? JSON.parse(fs.readFileSync(ALL_RESULTS_PATH, 'utf8')) : {};
}

/** Fetches fresh data for exactly `symbols` (today's batch), checkpointing within the batch for crash-resume. */
async function fetchBatch(symbols, cookies) {
  let checkpoint = {};
  if (fs.existsSync(BATCH_CHECKPOINT_PATH)) checkpoint = JSON.parse(fs.readFileSync(BATCH_CHECKPOINT_PATH, 'utf8'));

  for (const symbol of symbols) {
    if (checkpoint[symbol]) continue; // already fetched this batch (resumed after a crash)
    try {
      const result = await fetchFundamentals(symbol, cookies);
      checkpoint[symbol] = result || { failed: true };
    } catch (e) {
      checkpoint[symbol] = { failed: true, error: e.message };
    }
    fs.writeFileSync(BATCH_CHECKPOINT_PATH, JSON.stringify(checkpoint));
    await sleep(FETCH_DELAY_MS);
  }
  return checkpoint;
}

function computeSectorAveragePe(allResults) {
  const bySector = {};
  for (const [symbol, r] of Object.entries(allResults)) {
    if (!r || r.failed) continue;
    const sector = r.sectorTags?.['Sector'];
    if (!sector || r.pe == null) continue;
    (bySector[sector] = bySector[sector] || []).push(r.pe);
  }
  const avg = {};
  for (const [sector, pes] of Object.entries(bySector)) {
    avg[sector] = pes.reduce((s, v) => s + v, 0) / pes.length;
  }
  return avg;
}

function checkQualification(r, sectorAvgPe) {
  const checks = {};
  const sector = r.sectorTags?.['Sector'];
  const industryPe = sector != null ? sectorAvgPe[sector] : null;

  checks.halalBusiness = r.halalBusiness === true;
  checks.halalDebt = r.debtToAssetsPct != null && r.debtToAssetsPct < 33;
  checks.marketCapCr = r.marketCapCr != null && r.marketCapCr > THRESHOLDS.marketCapCr.min;
  checks.peg = r.peg != null && r.peg < THRESHOLDS.peg.max;
  checks.peVsIndustry = r.pe != null && industryPe != null && r.pe < industryPe;
  checks.roe = r.roe != null && r.roe > THRESHOLDS.roe.min;
  checks.roce = r.roce != null && r.roce > THRESHOLDS.roce.min;
  checks.debtToEquity = r.debtToEquity != null && r.debtToEquity < THRESHOLDS.debtToEquity.max;
  checks.promoterPct = r.promoterPct != null && r.promoterPct > THRESHOLDS.promoterPct.min;
  checks.salesGrowth3Y = r.salesGrowth3Y != null && r.salesGrowth3Y >= THRESHOLDS.salesGrowth3Y.min;
  checks.profitGrowth5Y = r.profitGrowth5Y != null && r.profitGrowth5Y > THRESHOLDS.profitGrowth5Y.min;
  checks.opmPct = r.opmPct != null && r.opmPct > THRESHOLDS.opmPct.min;
  checks.priceToSales = r.priceToSales != null && r.priceToSales < THRESHOLDS.priceToSales.max;
  checks.evToEbitda = r.evToEbitda != null && r.evToEbitda < THRESHOLDS.evToEbitda.max;
  // pledgePct deliberately excluded — always unavailable, not counted.

  const qualifies = Object.values(checks).every(Boolean);
  return { qualifies, checks, industryPe };
}

/**
 * Runs one day's batch: fetch fresh data for `symbols`, merge into the
 * persistent store, recompute sector-average PE from the full store,
 * recompute qualification for just this batch. Returns the full updated
 * store plus the set of symbols whose qualification actually changed this
 * run (for the caller to diff against the tracked-alerts list).
 */
async function runDailyBatch(symbols, cookies) {
  const allResults = loadAllResults();

  console.log(`Fetching ${symbols.length} stocks (today's batch)...`);
  const batchRaw = await fetchBatch(symbols, cookies);
  for (const [symbol, r] of Object.entries(batchRaw)) {
    if (r && !r.failed) allResults[symbol] = r;
    // failed fetches: leave any prior stored data as-is rather than overwrite with a failure.
  }

  const sectorAvgPe = computeSectorAveragePe(allResults);
  console.log(`Sector-average PE computed across ${Object.keys(sectorAvgPe).length} sectors (from full store).`);

  const batchResults = {};
  for (const symbol of symbols) {
    const r = allResults[symbol];
    if (!r || r.failed) continue;
    const { qualifies, checks, industryPe } = checkQualification(r, sectorAvgPe);
    allResults[symbol] = { ...r, industryPe, checks, qualifies };
    batchResults[symbol] = allResults[symbol];
  }

  fs.writeFileSync(ALL_RESULTS_PATH, JSON.stringify(allResults, null, 1));
  if (fs.existsSync(BATCH_CHECKPOINT_PATH)) fs.unlinkSync(BATCH_CHECKPOINT_PATH);

  const qualifyingInBatch = Object.values(batchResults).filter((r) => r.qualifies).length;
  console.log(`Batch complete. ${qualifyingInBatch}/${Object.keys(batchResults).length} in today's batch qualify.`);

  return { allResults, batchResults };
}

module.exports = { runDailyBatch, checkQualification, computeSectorAveragePe, loadAllResults, THRESHOLDS };
