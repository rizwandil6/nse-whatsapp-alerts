'use strict';

/**
 * Maintains each symbol's daily-candle cache, persisted via Postgres
 * (triple_rsi.daily_cache) when a DB is configured -- Railway's filesystem
 * is ephemeral across redeploys, so a local-file cache would force a full
 * re-backfill of all 353 symbols on every deploy. Falls back to a local
 * JSON file only when no DB is configured (local dev / dry-run).
 *
 * Only re-fetches daily candles from a few days before the last cached
 * date onward -- new symbols get a full backfill once, then it's
 * incremental. Same pattern as darvas-classic-strategy/live/weekly_cache.js
 * in this repo, minus the weekly resampling (this strategy runs on daily
 * bars directly).
 */

const fs = require('fs');
const path = require('path');
const { fetchDailyCandles } = require('./upstox_fetch');

const LOCAL_STORE_PATH = path.join(__dirname, 'daily_cache_store.json');
// 2 years: the 200-day MA needs ~200 trading days (~10 months) of lookback;
// 2 years leaves a comfortable margin for the RSI/distance-filter warmup too,
// while keeping the unauthenticated-endpoint rate-limit load reasonable.
const BACKFILL_YEARS = 2;
const REFETCH_LOOKBACK_DAYS = 10; // re-pull a small overlap in case the last session's bar was partial

function isoDate(d) { return d.toISOString().slice(0, 10); }

function loadLocalStore() {
  if (!fs.existsSync(LOCAL_STORE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(LOCAL_STORE_PATH, 'utf8')); } catch { return {}; }
}

function saveLocalStore(store) {
  fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(store));
}

/**
 * @param {import('./db').DB} db
 * @param {object} localStore in-memory local fallback store (only used when db.enabled is false)
 * @returns {Array} daily bars ascending, ending at (or just before) todayStr
 */
async function refreshSymbol(db, localStore, symbol, instrumentKey, todayStr) {
  const existingBars = db.enabled ? await db.getDailyBars(symbol) : localStore[symbol]?.dailyBars;

  const to = todayStr;
  let from;
  if (existingBars && existingBars.length) {
    const lastDate = existingBars[existingBars.length - 1].date;
    const lookback = new Date(lastDate + 'T00:00:00Z');
    lookback.setUTCDate(lookback.getUTCDate() - REFETCH_LOOKBACK_DAYS);
    from = isoDate(lookback);
  } else {
    const backfill = new Date();
    backfill.setUTCFullYear(backfill.getUTCFullYear() - BACKFILL_YEARS);
    from = isoDate(backfill);
  }

  const fresh = await fetchDailyCandles(instrumentKey, from, to);
  const byDate = new Map((existingBars || []).map((b) => [b.date, b]));
  for (const bar of fresh) byDate.set(bar.date, bar);
  const dailyBars = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  if (db.enabled) await db.saveDailyBars(symbol, dailyBars);
  else localStore[symbol] = { dailyBars };

  return dailyBars;
}

module.exports = { loadLocalStore, saveLocalStore, refreshSymbol, isoDate };
