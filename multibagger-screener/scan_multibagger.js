'use strict';

/**
 * Full-NSE-universe multibagger scan. Checkpointed and resumable — at
 * ~2,052 stocks and a polite request pace (rate-limit risk is real at this
 * volume, confirmed by direct testing during the smaller 353-stock halal
 * screen earlier in this project), a full run takes hours, not minutes.
 * If interrupted, re-running skips symbols already present in the
 * checkpoint file rather than starting over.
 *
 * Threshold checks — MISSING DATA CONVENTION: if a required parameter
 * can't be computed (scrape failure, or a divide-by-zero in a derived
 * metric like PEG), that check is treated as NOT SATISFIED, not
 * pass-through — the one deliberate exception is `pledgePct`, which is
 * always unavailable (see fundamental_screener.js) and is excluded from
 * the requirement entirely, per direct agreement.
 *
 * Industry PE substitute: computed as the average PE across ALL stocks in
 * the same Screener.in "Sector" tag (regardless of halal status — this
 * mirrors what a real "Industry PE" figure represents), precomputed ONCE
 * after the full batch is fetched, not per-stock.
 */

const fs = require('fs');
const path = require('path');
const { loginToScreener, fetchFundamentals } = require('./fundamental_screener');

const UNIVERSE_PATH = path.join(__dirname, 'nse_universe.json');
const RAW_CHECKPOINT_PATH = path.join(__dirname, 'raw_fundamentals_checkpoint.json');
const RESULTS_PATH = path.join(__dirname, 'scan_results.json');
const FETCH_DELAY_MS = parseInt(process.env.FETCH_DELAY_MS || '300', 10);
const CHECKPOINT_EVERY = 50;

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

async function fetchAllRaw(cookies) {
  const universe = JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf8'));
  const symbols = Object.keys(universe);

  let raw = {};
  if (fs.existsSync(RAW_CHECKPOINT_PATH)) raw = JSON.parse(fs.readFileSync(RAW_CHECKPOINT_PATH, 'utf8'));

  let fetched = 0;
  let failed = 0;
  for (const symbol of symbols) {
    if (raw[symbol]) continue; // already have it from a prior partial run
    try {
      const result = await fetchFundamentals(symbol, cookies);
      raw[symbol] = result || { failed: true };
      if (!result) failed++;
    } catch (e) {
      raw[symbol] = { failed: true, error: e.message };
      failed++;
    }
    fetched++;
    if (fetched % CHECKPOINT_EVERY === 0) {
      fs.writeFileSync(RAW_CHECKPOINT_PATH, JSON.stringify(raw));
      console.log(`  ...${Object.keys(raw).length}/${symbols.length} done (${fetched} this run, ${failed} failed this run)`);
    }
    await sleep(FETCH_DELAY_MS);
  }
  fs.writeFileSync(RAW_CHECKPOINT_PATH, JSON.stringify(raw));
  console.log(`Raw fetch complete. ${Object.keys(raw).length}/${symbols.length} total.`);
  return raw;
}

function computeSectorAveragePe(raw) {
  const bySector = {};
  for (const [symbol, r] of Object.entries(raw)) {
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
  checks.salesGrowth3Y = r.salesGrowth3Y != null && r.salesGrowth3Y > THRESHOLDS.salesGrowth3Y.min;
  checks.profitGrowth5Y = r.profitGrowth5Y != null && r.profitGrowth5Y > THRESHOLDS.profitGrowth5Y.min;
  checks.opmPct = r.opmPct != null && r.opmPct > THRESHOLDS.opmPct.min;
  checks.priceToSales = r.priceToSales != null && r.priceToSales < THRESHOLDS.priceToSales.max;
  checks.evToEbitda = r.evToEbitda != null && r.evToEbitda < THRESHOLDS.evToEbitda.max;
  // pledgePct deliberately excluded — always unavailable, not counted.

  const qualifies = Object.values(checks).every(Boolean);
  return { qualifies, checks, industryPe };
}

async function main() {
  // Env vars in the deployed container (Railway); fall back to the local
  // .secrets/ files for manual/local testing only.
  const username = process.env.SCREENER_USERNAME || fs.readFileSync(path.join(__dirname, '..', '.secrets', 'screener_username.txt'), 'utf8').trim();
  const password = process.env.SCREENER_PASSWORD || fs.readFileSync(path.join(__dirname, '..', '.secrets', 'screener_password.txt'), 'utf8').trim();
  const cookies = await loginToScreener(username, password);
  console.log('Logged in to Screener.in.');

  const raw = await fetchAllRaw(cookies);

  const sectorAvgPe = computeSectorAveragePe(raw);
  console.log(`Precomputed sector-average PE across ${Object.keys(sectorAvgPe).length} sectors.`);

  const results = {};
  let qualifyingCount = 0;
  for (const [symbol, r] of Object.entries(raw)) {
    if (!r || r.failed) continue;
    const { qualifies, checks, industryPe } = checkQualification(r, sectorAvgPe);
    results[symbol] = { ...r, industryPe, checks, qualifies };
    if (qualifies) qualifyingCount++;
  }

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 1));
  console.log(`Scan complete. ${qualifyingCount} stocks qualify out of ${Object.keys(results).length} scanned.`);
  console.log(`Written ${RESULTS_PATH}`);
}

module.exports = { checkQualification, computeSectorAveragePe, THRESHOLDS };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
