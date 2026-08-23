'use strict';

/**
 * Classic Darvas Box (weekly) — daily scan (runOnce), scheduled by service.js.
 *
 * Refreshes weekly candles for the 530-symbol universe (symbols.json, same
 * universe as swing-strategy/live), runs the box/entry/exit engine
 * (darvas_engine.js) for each, and upserts one row per position (open or
 * closed) into darvas_classic.positions -- a plain forward-tracking
 * dataset for the dashboard's P&L tab, same spirit as swing.signals.
 * No Telegram alerting -- this is dashboard-only.
 *
 * Only positions with an entry on/after TRACK_FROM are persisted -- box
 * formation still uses the full weekly history (the 52-week-high gate needs
 * a year+ of lookback), this just trims what gets tracked/displayed.
 *
 * Requires: DATABASE_URL (or .secrets/pg_url.txt) for state to persist.
 * No Upstox token needed -- historical candles are fetched unauthenticated
 * (see upstox_fetch.js).
 */

const { DB } = require('./db');
const { computeTradeLog, avgVolume } = require('./darvas_engine');
const { loadLocalStore, saveLocalStore, refreshSymbol } = require('./weekly_cache');
const symbolMap = require('./symbols.json');

const CONCURRENCY = 3; // unauthenticated Upstox endpoint rate-limits (HTTP 429) aggressively above this
const REQUEST_STAGGER_MS = 400; // small per-request delay on top of concurrency limiting
const TRACK_FROM = '2026-01-01';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const f = (x) => (x == null ? null : Number(x));
const pnlPct = (entry, exit) => Math.round(((exit - entry) / entry) * 1000) / 10;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function runOnce() {
  const db = new DB();
  const todayStr = new Date().toISOString().slice(0, 10);
  await db.init();
  const localStore = db.enabled ? {} : loadLocalStore();

  const entries = Object.entries(symbolMap);
  console.log(`Darvas Classic weekly scan — ${todayStr} — ${entries.length} symbols — tracking positions from ${TRACK_FROM}`);

  const results = await mapLimit(entries, CONCURRENCY, async ([symbol, instrumentKey]) => {
    let weekly;
    try {
      weekly = await refreshSymbol(db, localStore, symbol, instrumentKey, todayStr);
    } catch (e) {
      console.warn(`  ${symbol}: fetch failed — ${e.message}`);
      return null;
    } finally {
      await sleep(REQUEST_STAGGER_MS);
    }
    if (weekly.length < 52) return null;
    const { closedTrades, openPosition, confirmedBox } = computeTradeLog(weekly);
    return { symbol, weekly, closedTrades, openPosition, confirmedBox };
  });

  let positionsWritten = 0;
  const watchlist = [];
  for (const r of results) {
    if (!r) continue;
    const { symbol, closedTrades, openPosition, confirmedBox } = r;

    // Group closed legs by positionId (darvas_engine.js tags every leg of a
    // pyramided group with the same id) into one row per position.
    const groups = new Map();
    for (const leg of closedTrades) {
      if (leg.entryDate < TRACK_FROM) continue;
      if (!groups.has(leg.positionId)) groups.set(leg.positionId, []);
      groups.get(leg.positionId).push(leg);
    }
    for (const legs of groups.values()) {
      legs.sort((a, b) => a.legIndex - b.legIndex);
      const first = legs[0];
      const last = legs[legs.length - 1];
      await db.upsertPosition({
        symbol,
        entryDate: first.entryDate,
        entryPrice: first.entryPrice,
        status: 'closed',
        legs: legs.length,
        legsJson: legs.map((l) => ({ legIndex: l.legIndex, entryDate: l.entryDate, entryPrice: l.entryPrice })),
        trailStop: f(last.exitPrice),
        exitDate: last.exitDate,
        exitPrice: f(last.exitPrice),
        exitReason: last.exitReason,
        pnlPct: pnlPct(first.entryPrice, last.exitPrice),
      });
      positionsWritten++;
    }

    if (openPosition && openPosition.legs[0].entryDate >= TRACK_FROM) {
      const first = openPosition.legs[0];
      // Baseline P&L off the most recent weekly close, since the dashboard only
      // overwrites this with a true live price during market hours (see
      // DashboardDataController.darvasClassic) -- without this, "since alert %"
      // would show blank outside market hours / before a price attaches.
      const lastClose = r.weekly[r.weekly.length - 1].close;
      await db.upsertPosition({
        symbol,
        entryDate: first.entryDate,
        entryPrice: first.entryPrice,
        status: 'open',
        legs: openPosition.legs.length,
        legsJson: openPosition.legs,
        trailStop: f(openPosition.trailStop),
        lastPrice: f(lastClose),
        pnlPct: pnlPct(first.entryPrice, lastClose),
      });
      positionsWritten++;
    }

    // Watchlist candidate: a confirmed box with no open position yet -- the
    // intraday watcher checks these for a real-time breakout during market
    // hours (see intraday_watcher.js). No entryDate/TRACK_FROM filter here --
    // this is a forward-looking "could trigger tomorrow" list, not history.
    if (!openPosition && confirmedBox) {
      const lastBar = r.weekly[r.weekly.length - 1];
      const triggerPrice = confirmedBox.top * 1.01;
      const vol = avgVolume(r.weekly, r.weekly.length - 1);
      watchlist.push({
        symbol,
        boxTop: confirmedBox.top,
        boxBottom: confirmedBox.bottom,
        triggerPrice,
        avgVolume: vol,
        lastPrice: lastBar.close,
        distancePct: Math.round((((triggerPrice - lastBar.high) / triggerPrice) * 1000)) / 10,
      });
    }
  }

  await db.replaceWatchlist(watchlist);

  if (!db.enabled) saveLocalStore(localStore);
  if (db.pool) await db.pool.end();
  console.log(`Scan complete. ${positionsWritten} position(s) written, ${watchlist.length} watchlist candidate(s).`);
}

module.exports = { runOnce };
