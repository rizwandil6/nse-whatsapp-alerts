'use strict';

/**
 * Fetches trailing ~14-month Daily candles for Nifty 50 + the full stock
 * universe, FRESH every run — no persisted raw price cache. RS ranking
 * only needs a rolling ~12-month window (see rs_rank.js's LOOKBACKS), so
 * there's no reason to git-commit years of raw OHLCV data the way the
 * backtest's cache does; re-fetching ~354 instruments once/day is cheap
 * and keeps this service's git state small (see git_state.js).
 */

const symbols = require('./symbols.json');

const LOOKBACK_MONTHS = 14; // 12mo needed for the longest RS lookback + 2mo buffer for holidays/weekends near the boundary
const FETCH_DELAY_MS = 150; // small delay between sequential requests, same spirit as this project's other Upstox fetchers

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isoDateMonthsAgo(months) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchDaily(instrumentKey, token) {
  const from = isoDateMonthsAgo(LOOKBACK_MONTHS);
  const to = isoToday();
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/day/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const raw = body?.data?.candles || [];
  return raw
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

/** Returns { nifty: [...candles], bySymbol: { symbol: [...candles] } }. Logs (doesn't throw) on a per-symbol fetch failure -- one bad symbol shouldn't abort the whole run. */
async function fetchUniverse(token) {
  console.log('Fetching Nifty 50...');
  const nifty = await fetchDaily('NSE_INDEX|Nifty 50', token);
  console.log(`  -> ${nifty.length} candles`);
  await sleep(FETCH_DELAY_MS);

  const bySymbol = {};
  const symbolEntries = Object.entries(symbols);
  let failed = 0;
  for (let i = 0; i < symbolEntries.length; i++) {
    const [symbol, instrumentKey] = symbolEntries[i];
    try {
      const candles = await fetchDaily(instrumentKey, token);
      bySymbol[symbol] = candles;
    } catch (e) {
      failed++;
      console.warn(`  FAILED ${symbol}: ${e.message}`);
    }
    if ((i + 1) % 50 === 0) console.log(`  ...${i + 1}/${symbolEntries.length} stocks fetched`);
    await sleep(FETCH_DELAY_MS);
  }
  console.log(`Fetched ${Object.keys(bySymbol).length}/${symbolEntries.length} stocks (${failed} failed).`);
  return { nifty, bySymbol };
}

module.exports = { fetchUniverse, fetchDaily, LOOKBACK_MONTHS };
