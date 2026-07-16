'use strict';

/**
 * Screener.in fundamental data fetcher, built fresh for the "multibagger"
 * parameter screen (see chat for the full parameter list and reasoning).
 * Ports the login/session-cookie flow from the existing Java
 * FundamentalScreener (src/main/java/com/adil/nsealerts/FundamentalScreener.java)
 * into Node — verified against real fetched pages (TCS, DLF, ZEEL, RPOWER)
 * before writing this, not guessed.
 *
 * Two parameters from the requested 13 are NOT directly available and are
 * substituted, per direct discussion:
 *   - Industry PE: not present on any tested company page (may have been
 *     removed by Screener.in, or is premium-gated). Substituted with a
 *     homemade sector-average PE, computed by the caller across a batch of
 *     stocks using the existing swing-strategy sector_map.json — this
 *     module only returns the raw `pe`; the sector-average comparison
 *     happens one level up, where the full batch is available.
 *   - Pledged %: not present in the static HTML for any tested stock
 *     (loaded via an authenticated AJAX call this module does not replicate,
 *     likely premium-gated). Returned as `pledgePct: null` — treat as
 *     "unavailable, pass-through", the same convention used elsewhere in
 *     this project for missing sector classifications.
 *
 * Everything else (Market Cap, PE, ROE, ROCE, Promoter %, Sales Growth 3Y,
 * Profit Growth 5Y, OPM%, Debt/Equity, debt-to-assets for the halal check)
 * is scraped directly. Price/Sales, EV/EBITDA, and PEG are derived from
 * those scraped figures rather than scraped separately (see README for the
 * exact formulas and their approximations).
 */

const cheerio = require('cheerio');
const { classifyHalalBusiness, parseSectorTags } = require('./halal_classifier');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LOGIN_URL = 'https://www.screener.in/login/';
const SEARCH_URL = 'https://www.screener.in/api/company/search/?q=%s&v=3&fts=1';
const COMPANY_CONSOLIDATED_URL = 'https://www.screener.in/company/%s/consolidated/';
const COMPANY_URL = 'https://www.screener.in/company/%s/';

function parseSetCookie(res) {
  const cookies = {};
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return cookies;
}
function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function loginToScreener(username, password) {
  const loginPageRes = await fetch(LOGIN_URL, { headers: { 'User-Agent': USER_AGENT } });
  const loginPageHtml = await loginPageRes.text();
  const $ = cheerio.load(loginPageHtml);
  const csrfToken = $('input[name=csrfmiddlewaretoken]').attr('value');
  if (!csrfToken) throw new Error('Could not find CSRF token on Screener.in login page');
  const initialCookies = parseSetCookie(loginPageRes);

  const body = new URLSearchParams({ username, password, csrfmiddlewaretoken: csrfToken, next: '/' });
  const loginRes = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: LOGIN_URL,
      Cookie: cookieHeader(initialCookies),
    },
    body: body.toString(),
    redirect: 'manual',
  });
  const loginCookies = parseSetCookie(loginRes);
  const cookies = { ...initialCookies, ...loginCookies };
  if (!cookies.sessionid) throw new Error('Screener.in login failed — no sessionid in response');
  return cookies;
}

async function resolveScreenerSymbol(companyName, cookies) {
  const url = SEARCH_URL.replace('%s', encodeURIComponent(companyName));
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Cookie: cookieHeader(cookies) } });
  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) return null;
  const link = results[0].url || '';
  if (!link.startsWith('/company/')) return null;
  const afterCompany = link.slice('/company/'.length);
  const nextSlash = afterCompany.indexOf('/');
  const sym = (nextSlash >= 0 ? afterCompany.slice(0, nextSlash) : afterCompany).trim();
  return sym || null;
}

async function fetchScreenerPageHtml(symbol, cookies, consolidated) {
  const url = (consolidated ? COMPANY_CONSOLIDATED_URL : COMPANY_URL).replace('%s', symbol);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Cookie: cookieHeader(cookies) } });
  const html = await res.text();
  if (html.includes('id="login-form"') || res.url?.includes('/login')) return null; // session expired
  const $ = cheerio.load(html);
  if ($('#top-ratios li').length === 0) return null;
  return html;
}

// ── Parsers ──────────────────────────────────────────────────────────────

function parseNum(text) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/₹/g, '')
    .replace(/[,\s]/g, '')
    .replace(/Cr\.?/g, '')
    .replace(/%/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '—') return null;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

function parseTopRatios($) {
  const ratios = {};
  $('#top-ratios li, .company-ratios li').each((_, el) => {
    const $el = $(el);
    const name = $el.find('.name').first().clone().children().remove().end().text().trim().replace(/\s*\(.*?\)/g, '').trim();
    const value = $el.find('.value, .number').first().text().trim();
    if (name && value) ratios[name] = value;
  });
  return ratios;
}

/** Parses either "Compounded Sales Growth" or "Compounded Profit Growth" tables — same structure. */
function parseCompoundedGrowth($, thLabel) {
  const out = {};
  $('th').each((_, th) => {
    const $th = $(th);
    if (!$th.text().trim().toLowerCase().includes(thLabel.toLowerCase())) return;
    const table = $th.closest('table');
    if (!table.length) return;
    table.find('tr').each((__, tr) => {
      const tds = $(tr).find('td');
      if (tds.length === 0) return;
      const labelText = $(tds[0]).text().trim().toLowerCase();
      if (!labelText) return;
      let pct = parseLastNumber($(tds[0]).text());
      if (pct == null && tds.length > 1) pct = parseLastNumber($(tds[1]).text());
      if (labelText.includes('10')) out.y10 = pct;
      else if (labelText.includes('ttm')) out.ttm = pct;
      else if (labelText.includes('5')) out.y5 = pct;
      else if (labelText.includes('3')) out.y3 = pct;
    });
  });
  return out;
}

function parseLastNumber(text) {
  if (!text) return null;
  const m = /(-?\d+(?:\.\d+)?)\s*%?\s*$/.exec(text.trim());
  return m ? parseFloat(m[1]) : null;
}

/** Latest (most recent quarter) OPM % from the #quarters table. */
function parseLatestOPM($) {
  const section = $('#quarters');
  if (!section.length) return null;
  let opm = null;
  section.find('table.data-table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length === 0) return;
    const label = $(tds[0]).text().trim().toLowerCase();
    if (label.startsWith('opm')) {
      // last non-empty cell = most recent quarter
      for (let i = tds.length - 1; i >= 1; i--) {
        const v = parseNum($(tds[i]).text());
        if (v != null) { opm = v; break; }
      }
    }
  });
  return opm;
}

/** Latest TTM Sales (sum of last 4 quarters) from the #quarters table, for Price/Sales. */
function parseTtmSales($) {
  const section = $('#quarters');
  if (!section.length) return null;
  let vals = [];
  section.find('table.data-table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length === 0) return;
    const label = $(tds[0]).text().trim().toLowerCase();
    if (label.startsWith('sales') || label.startsWith('revenue from operations')) {
      vals = [];
      for (let i = 1; i < tds.length; i++) {
        const v = parseNum($(tds[i]).text());
        if (v != null) vals.push(v);
      }
    }
  });
  if (vals.length < 4) return null;
  return vals.slice(-4).reduce((s, v) => s + v, 0);
}

function parseBalanceSheet($) {
  const section = $('#balance-sheet');
  const out = { totalDebtCr: null, reservesCr: null, totalAssetsCr: null };
  if (!section.length) return out;
  section.find('table.data-table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length === 0) return;
    const label = $(tds[0]).text().trim().toLowerCase();
    const latest = (() => {
      for (let i = tds.length - 1; i >= 1; i--) {
        const v = parseNum($(tds[i]).text());
        if (v != null) return v;
      }
      return null;
    })();
    if (label.startsWith('borrowings')) out.totalDebtCr = latest;
    else if (label.startsWith('reserves')) out.reservesCr = latest;
    else if (label.startsWith('total assets') || label.startsWith('total liabilities')) out.totalAssetsCr = latest;
  });
  return out;
}

function parsePromoterPct($) {
  const section = $('#shareholding');
  if (!section.length) return null;
  let pct = null;
  section.find('table.data-table tbody tr').each((_, tr) => {
    if (pct != null) return;
    const tds = $(tr).find('td');
    if (tds.length === 0) return;
    if ($(tds[0]).text().trim().toLowerCase().startsWith('promoters')) {
      pct = parseNum($(tds[tds.length - 1]).text().trim());
    }
  });
  return pct;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Fetches and parses all fundamentals for one stock. `cookies` must come
 * from loginToScreener(). Returns null if the stock can't be resolved or
 * the page can't be fetched (network/session issue) — caller should treat
 * that as "skip this stock", not "fails the screen".
 */
async function fetchFundamentals(companyNameOrSymbol, cookies) {
  const screenerSymbol = await resolveScreenerSymbol(companyNameOrSymbol, cookies);
  if (!screenerSymbol) return null;

  let html = await fetchScreenerPageHtml(screenerSymbol, cookies, true);
  if (!html) html = await fetchScreenerPageHtml(screenerSymbol, cookies, false);
  if (!html) return null;

  const $ = cheerio.load(html);
  const ratios = parseTopRatios($);
  const companyName = $('h1').first().text().trim() || screenerSymbol;

  const marketCapCr = parseNum(ratios['Market Cap'] ?? ratios['Mkt Cap']);
  const pe = parseNum(ratios['Stock P/E'] ?? ratios['P/E']);
  const roe = parseNum(ratios['ROE']);
  const roce = parseNum(ratios['ROCE']);
  const bookValue = parseNum(ratios['Book Value']);
  const currentPrice = parseNum(ratios['Current Price']);

  const promoterPct = parsePromoterPct($);
  const salesGrowth = parseCompoundedGrowth($, 'compounded sales growth');
  const profitGrowth = parseCompoundedGrowth($, 'compounded profit growth');
  const opmPct = parseLatestOPM($);
  const ttmSalesCr = parseTtmSales($);
  const { totalDebtCr, reservesCr, totalAssetsCr } = parseBalanceSheet($);

  const debt = totalDebtCr ?? 0;
  const equityCr = reservesCr != null ? reservesCr : null; // approximation: reserves ~ equity base (no separate share-capital row parsed)
  const debtToEquity = equityCr != null && equityCr > 0 ? debt / equityCr : (debt === 0 ? 0 : null);
  const debtToAssetsPct = totalAssetsCr != null && totalAssetsCr > 0 ? (debt / totalAssetsCr) * 100 : null;

  const priceToSales = marketCapCr != null && ttmSalesCr != null && ttmSalesCr > 0 ? marketCapCr / ttmSalesCr : null;
  const ebitdaCr = ttmSalesCr != null && opmPct != null ? ttmSalesCr * (opmPct / 100) : null;
  const evToEbitda = marketCapCr != null && ebitdaCr != null && ebitdaCr > 0 ? (marketCapCr + debt) / ebitdaCr : null;
  const profitGrowth5Y = profitGrowth.y5 ?? null;
  const peg = pe != null && profitGrowth5Y != null && profitGrowth5Y > 0 ? pe / profitGrowth5Y : null;

  const sectorTags = parseSectorTags($);
  const halal = classifyHalalBusiness(screenerSymbol, sectorTags);

  return {
    symbol: screenerSymbol,
    companyName,
    sectorTags,
    halalBusiness: halal.halalBusiness, // true/false/null (null = couldn't classify)
    halalBusinessReason: halal.reason,
    marketCapCr,
    pe,
    roe,
    roce,
    bookValue,
    currentPrice,
    promoterPct,
    salesGrowth3Y: salesGrowth.y3 ?? null,
    profitGrowth5Y,
    opmPct,
    totalDebtCr,
    reservesCr,
    totalAssetsCr,
    debtToEquity,
    debtToAssetsPct, // for the halal debt-to-assets < 33% re-check
    ttmSalesCr,
    priceToSales,
    evToEbitda,
    peg,
    pledgePct: null, // unavailable via free scraping — see module doc comment
  };
}

module.exports = { loginToScreener, resolveScreenerSymbol, fetchFundamentals };
