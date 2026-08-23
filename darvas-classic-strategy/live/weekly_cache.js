'use strict';

/**
 * Maintains each symbol's daily-candle cache and resamples it into weekly
 * OHLCV bars. Persisted via Postgres (darvas_classic.daily_cache) when a DB
 * is configured -- Railway's filesystem is ephemeral across redeploys, so a
 * local-file cache would force a full 5-year re-backfill of all 530 symbols
 * on every deploy. Falls back to a local JSON file only when no DB is
 * configured (local dev / dry-run).
 *
 * Only re-fetches daily candles from a few days before the last cached
 * date onward -- new symbols get a full backfill once, then it's
 * incremental.
 */

const fs = require('fs');
const path = require('path');
const { fetchDailyCandles, isoDate } = require('./upstox_fetch');

const LOCAL_STORE_PATH = path.join(__dirname, 'weekly_cache_store.json');
const BACKFILL_YEARS = 5;
const REFETCH_LOOKBACK_DAYS = 10; // re-pull a small overlap in case the last week was partial

function loadLocalStore() {
  if (!fs.existsSync(LOCAL_STORE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(LOCAL_STORE_PATH, 'utf8')); } catch { return {}; }
}

function saveLocalStore(store) {
  fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(store));
}

function weekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.toISOString().slice(0, 10); // Monday of that week
}

function resampleToWeekly(dailyBars) {
  const weeks = new Map();
  for (const bar of dailyBars) {
    const key = weekKey(bar.date);
    let w = weeks.get(key);
    if (!w) {
      w = { date: key, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0 };
      weeks.set(key, w);
    }
    w.high = Math.max(w.high, bar.high);
    w.low = Math.min(w.low, bar.low);
    w.close = bar.close; // daily bars arrive ascending, so last write wins
    w.volume += bar.volume;
  }
  return [...weeks.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Refreshes and returns weekly bars for one symbol.
 * @param {import('./db').DB} db
 * @param {object} localStore  in-memory local fallback store (only used when db.enabled is false)
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

  return resampleToWeekly(dailyBars);
}

module.exports = { loadLocalStore, saveLocalStore, refreshSymbol, resampleToWeekly, weekKey };
