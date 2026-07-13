'use strict';

/**
 * Halal business-type classifier, built for the full-NSE-universe
 * multibagger screen (independent of the existing 353-stock Nifty500-CSV-
 * based screening used elsewhere in this project, since this needs to
 * cover companies well outside the Nifty 500).
 *
 * Uses Screener.in's own 4-level sector taxonomy (Broad Sector > Sector >
 * Broad Industry > Industry), parsed from the Peer Comparison section's
 * breadcrumb links. Verified directly against real pages before writing
 * this — "Industry" (the most granular level) cleanly distinguishes:
 *   HDFCBANK   -> "Private Sector Bank"              (exclude: bank)
 *   BAJFINANCE -> "Non Banking Financial Company (NBFC)" (exclude: NBFC)
 *   UBL        -> "Breweries & Distilleries"          (exclude: alcohol)
 *   VSTIND     -> "Cigarettes & Tobacco Products"      (exclude: tobacco)
 *   BRITANNIA  -> "Packaged Foods"                     (fine — same Broad
 *                 Sector as UBL/VSTIND, "Fast Moving Consumer Goods", but
 *                 the finer Industry tag correctly separates them)
 *
 * Known gap, found by testing: gambling/casino operators don't get a clean
 * keyword-matchable tag — Delta Corp shows as "Amusement Parks/ Other
 * Recreation", indistinguishable by keyword from legitimate recreation
 * businesses. Supplemented with a small manual denylist for known cases
 * rather than silently missing them.
 */

const EXCLUDE_KEYWORDS = [
  /\bbank\b/i,
  /non banking financial/i,
  /\bnbfc\b/i,
  /brewer/i,
  /distiller/i,
  /\balcohol/i,
  /\bliquor/i,
  /tobacco/i,
  /cigarette/i,
  /\bcasino/i,
  /\bgambling/i,
  /\blottery/i,
  /\bbetting/i,
];

// Known gambling/casino operators that don't get a keyword-matchable
// Screener.in industry tag (e.g. "Amusement Parks/ Other Recreation").
// Extend this list if more such cases are found.
const MANUAL_DENYLIST = new Set(['DELTACORP', 'NAZARA', 'ONMOBILE']);

function parseSectorTags($) {
  const tags = {};
  $('#peers a[title]').each((_, el) => {
    const $el = $(el);
    const level = $el.attr('title');
    if (['Broad Sector', 'Sector', 'Broad Industry', 'Industry'].includes(level)) {
      tags[level] = $el.text().trim();
    }
  });
  return tags;
}

/**
 * Returns { halalBusiness: boolean|null, reason: string|null, tags: {...} }.
 * `tags` comes from parseSectorTags($) — called once, on the same cheerio
 * object fundamental_screener.js already builds from its single page fetch
 * (no duplicate network request per stock).
 */
function classifyHalalBusiness(symbol, tags) {
  if (MANUAL_DENYLIST.has(symbol.toUpperCase())) {
    return { halalBusiness: false, reason: 'Manual denylist (gambling/casino operator)', tags };
  }
  const checkText = [tags?.['Industry'], tags?.['Broad Industry']].filter(Boolean).join(' | ');
  if (!checkText) {
    return { halalBusiness: null, reason: 'No sector tags found — cannot classify', tags };
  }
  for (const re of EXCLUDE_KEYWORDS) {
    if (re.test(checkText)) {
      return { halalBusiness: false, reason: `Excluded business type: "${checkText}" matched ${re}`, tags };
    }
  }
  return { halalBusiness: true, reason: null, tags };
}

module.exports = { classifyHalalBusiness, parseSectorTags, EXCLUDE_KEYWORDS, MANUAL_DENYLIST };
