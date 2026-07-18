'use strict';

/**
 * Telegram alert formatting, matching the format confirmed directly:
 * full parameter dump on first qualification, focused diff on loss
 * (including halal-loss specifically flagged, agreed to fire the same
 * alert type as a parameter loss).
 */

function fmtPct(v) {
  return v == null ? 'n/a' : v.toFixed(1) + '%';
}
function fmtNum(v) {
  return v == null ? 'n/a' : v.toFixed(2);
}
function mark(passed) {
  return passed ? '✅' : '❌';
}

function formatNewCandidateAlert(symbol, r) {
  const sector = r.sectorTags?.['Industry'] || r.sectorTags?.['Sector'] || 'n/a';
  const lines = [
    '[MULTIBAGGER SCREEN] New candidate found',
    `Stock: ${symbol}`,
    `Sector: ${sector}`,
    '',
    `Halal: ${mark(r.checks.halalBusiness && r.checks.halalDebt)} Compliant (debt/assets: ${fmtPct(r.debtToAssetsPct)})`,
    '',
    `Market Cap: Rs ${r.marketCapCr != null ? r.marketCapCr.toLocaleString('en-IN') : 'n/a'} Cr (need >1,000 Cr) ${mark(r.checks.marketCapCr)}`,
    `PEG: ${fmtNum(r.peg)} (need <1) ${mark(r.checks.peg)}`,
    `PE vs Sector Avg PE: ${fmtNum(r.pe)} vs ${fmtNum(r.industryPe)} ${mark(r.checks.peVsIndustry)}`,
    `ROE: ${fmtPct(r.roe)} (need >20%) ${mark(r.checks.roe)}`,
    `ROCE: ${fmtPct(r.roce)} (need >15%) ${mark(r.checks.roce)}`,
    `Debt/Equity: ${fmtNum(r.debtToEquity)} (need <0.5) ${mark(r.checks.debtToEquity)}`,
    `Promoter: ${fmtPct(r.promoterPct)} (need >50%) ${mark(r.checks.promoterPct)}`,
    `Sales Gr 3Y: ${fmtPct(r.salesGrowth3Y)} (need >=15%) ${mark(r.checks.salesGrowth3Y)}`,
    `Profit Gr 5Y: ${fmtPct(r.profitGrowth5Y)} (need >15%) ${mark(r.checks.profitGrowth5Y)}`,
    'Pledged: unavailable (not checked — see README)',
    `OPM: ${fmtPct(r.opmPct)} (need >15%) ${mark(r.checks.opmPct)}`,
    `Price/Sales: ${fmtNum(r.priceToSales)} (need <10) ${mark(r.checks.priceToSales)}`,
    `EV/EBITDA: ${fmtNum(r.evToEbitda)} (need <25) ${mark(r.checks.evToEbitda)}`,
    '',
    '(Fundamental screen only — no technical entry timing. Alert only, no order placed.)',
  ];
  return lines.join('\n');
}

function formatLostQualificationAlert(symbol, firstQualified, failedChecks, currentData, previousData) {
  const lines = [
    '[MULTIBAGGER SCREEN] Lost qualification',
    `Stock: ${symbol}`,
    `First qualified: ${firstQualified}`,
    '',
    'Now failing:',
  ];
  for (const f of failedChecks) {
    const halalTag = f.isHalal ? ' [HALAL]' : '';
    const prevVal = previousData ? describePrevValue(f.key, previousData) : null;
    lines.push(`  ${f.label}${halalTag} ❌${prevVal ? ` — was ${prevVal}` : ''}`);
  }
  lines.push('', 'Removed from tracked list.');
  return lines.join('\n');
}

function describePrevValue(key, prevData) {
  const map = {
    halalBusiness: () => (prevData.halalBusiness ? 'compliant' : null),
    halalDebt: () => (prevData.debtToAssetsPct != null ? fmtPct(prevData.debtToAssetsPct) : null),
    marketCapCr: () => (prevData.marketCapCr != null ? `Rs ${prevData.marketCapCr.toLocaleString('en-IN')} Cr` : null),
    peg: () => fmtNum(prevData.peg),
    peVsIndustry: () => (prevData.pe != null ? fmtNum(prevData.pe) : null),
    roe: () => fmtPct(prevData.roe),
    roce: () => fmtPct(prevData.roce),
    debtToEquity: () => fmtNum(prevData.debtToEquity),
    promoterPct: () => fmtPct(prevData.promoterPct),
    salesGrowth3Y: () => fmtPct(prevData.salesGrowth3Y),
    profitGrowth5Y: () => fmtPct(prevData.profitGrowth5Y),
    opmPct: () => fmtPct(prevData.opmPct),
    priceToSales: () => fmtNum(prevData.priceToSales),
    evToEbitda: () => fmtNum(prevData.evToEbitda),
  };
  const fn = map[key];
  return fn ? fn() : null;
}

module.exports = { formatNewCandidateAlert, formatLostQualificationAlert };
