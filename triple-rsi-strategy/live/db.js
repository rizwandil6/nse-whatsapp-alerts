'use strict';

/**
 * Postgres persistence for the Triple RSI live scanner -- daily-candle
 * cache + one row per position (open or closed), plus entry/exit alert
 * dedupe flags so a Telegram alert is sent exactly once per event. Same
 * pattern as darvas-classic-strategy/live/db.js in this repo.
 *
 * Connection string comes from DATABASE_URL (Railway env) or, for local
 * runs, .secrets/pg_url.txt. If NEITHER is present the module degrades to
 * a no-op -- the scanner still computes trade logs, it just doesn't persist
 * (and every position looks "new" on every run, so alerting is effectively
 * disabled too -- Postgres is required for real use, not optional).
 *
 * NOTE: this file never contains a credential. The connection string is
 * read at runtime from env / .secrets, which the operator populates.
 */

const fs = require('fs');
const path = require('path');

let Pool = null;
try { ({ Pool } = require('pg')); } catch (_) { /* pg not installed yet */ }

// Fixed system identity for syncPortfolioWatchlist (see below) -- not a real
// browser_id, so it never shows up in anyone's own Portfolio tab (that UI is
// keyed by a per-browser localStorage id, see index.html's getBrowserId).
const PORTFOLIO_SYSTEM_BROWSER_ID = 'triple-rsi-auto';

function resolveConnString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  const p = path.join(__dirname, '..', '..', '.secrets', 'pg_url.txt');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  return null;
}

class DB {
  constructor() {
    this.pool = null;
    this.enabled = false;
    const conn = resolveConnString();
    if (!conn) { console.warn('WARNING: no DATABASE_URL / .secrets/pg_url.txt — Postgres logging DISABLED.'); return; }
    if (!Pool) { console.warn('WARNING: pg module not installed — Postgres logging DISABLED. Run `npm install`.'); return; }
    const isLocal = /localhost|127\.0\.0\.1/.test(conn);
    const ssl = process.env.PGSSL === 'disable' || isLocal ? false : { rejectUnauthorized: false };
    this.pool = new Pool({ connectionString: conn, ssl, max: 4 });
    this.pool.on('error', (e) => console.warn('  pg pool error:', e.message));
    this.enabled = true;
  }

  async init() {
    if (!this.enabled) return;
    try {
      const ddl = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await this.pool.query(ddl);
      console.log('Postgres schema ready (triple_rsi.*).');
    } catch (e) {
      console.error('FATAL-ish: schema init failed — disabling Postgres logging:', e.message);
      this.enabled = false;
    }
  }

  async _q(text, params) {
    if (!this.enabled) return null;
    try { return await this.pool.query(text, params); }
    catch (e) { console.warn('  pg query failed:', e.message); return null; }
  }

  async getDailyBars(symbol) {
    if (!this.enabled) return null;
    const r = await this._q(`SELECT daily_bars_json FROM triple_rsi.daily_cache WHERE symbol=$1`, [symbol]);
    if (!r || r.rowCount === 0) return null;
    return r.rows[0].daily_bars_json;
  }

  async saveDailyBars(symbol, dailyBars) {
    await this._q(
      `INSERT INTO triple_rsi.daily_cache (symbol, daily_bars_json, updated_at)
       VALUES ($1,$2,now())
       ON CONFLICT (symbol) DO UPDATE SET daily_bars_json=$2, updated_at=now()`,
      [symbol, JSON.stringify(dailyBars)]
    );
  }

  /** Existing DB row for one (symbol, entryDate), or null. Used to preserve alert-dedupe flags across runs. */
  async getPosition(symbol, entryDate) {
    if (!this.enabled) return null;
    const r = await this._q(
      `SELECT * FROM triple_rsi.positions WHERE symbol=$1 AND entry_date=$2`,
      [symbol, entryDate]
    );
    return r && r.rowCount > 0 ? r.rows[0] : null;
  }

  async upsertPosition({
    symbol, entryDate, entryPrice, stopPrice, status, barsHeld, minHoldSatisfied,
    exitDate, exitPrice, exitReason, returnPct, lastPrice, entryAlerted, exitAlerted,
  }) {
    await this._q(
      `INSERT INTO triple_rsi.positions
         (symbol, entry_date, entry_price, stop_price, status, bars_held, min_hold_satisfied,
          exit_date, exit_price, exit_reason, return_pct, last_price, entry_alerted, exit_alerted, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       ON CONFLICT (symbol, entry_date) DO UPDATE SET
         entry_price=$3, stop_price=$4, status=$5, bars_held=$6, min_hold_satisfied=$7,
         exit_date=$8, exit_price=$9, exit_reason=$10, return_pct=$11, last_price=$12,
         entry_alerted=$13, exit_alerted=$14, updated_at=now()`,
      [symbol, entryDate, entryPrice, stopPrice, status, barsHeld, minHoldSatisfied,
        exitDate ?? null, exitPrice ?? null, exitReason ?? null, returnPct ?? null, lastPrice ?? null,
        entryAlerted, exitAlerted]
    );
  }

  // Deletes any position rows for this symbol NOT in validEntryDates -- the
  // recompute is deterministic and full each run, so a row that no longer
  // appears in the fresh output is stale (superseded by a logic/threshold
  // change, or a past bug) and should not linger forever. Same rationale as
  // darvas-classic-strategy/live/db.js's prunePositions.
  async prunePositions(symbol, validEntryDates) {
    if (!this.enabled) return;
    if (validEntryDates.length === 0) {
      await this._q('DELETE FROM triple_rsi.positions WHERE symbol=$1', [symbol]);
      return;
    }
    await this._q(
      'DELETE FROM triple_rsi.positions WHERE symbol=$1 AND entry_date <> ALL($2::date[])',
      [symbol, validEntryDates]
    );
  }

  async getOpenPositions() {
    if (!this.enabled) return [];
    const r = await this._q(`SELECT * FROM triple_rsi.positions WHERE status='open' ORDER BY entry_date`);
    return r ? r.rows : [];
  }

  /**
   * Syncs portfolio.tickers (owned by the Java "web" app's schema.sql, see
   * PortfolioService.java) so every currently open Triple RSI position rides
   * the existing 08:00 IST TradingAgents daily-analysis job for free
   * (market+news+fundamentals analysts -> decision+reasoning), without
   * building a second news pipeline. Runs under the fixed
   * PORTFOLIO_SYSTEM_BROWSER_ID -- adds newly-opened symbols, removes ones
   * no longer open. portfolio.tickers' per-portfolio add cap (20) lives in
   * PortfolioService.addTicker, a Java-endpoint-only guard -- this writes
   * directly via SQL so it doesn't apply here.
   */
  async syncPortfolioWatchlist(openSymbols) {
    if (!this.enabled) return { added: 0, removed: 0 };
    const existing = await this._q(
      `SELECT ticker FROM portfolio.tickers WHERE browser_id=$1`,
      [PORTFOLIO_SYSTEM_BROWSER_ID]
    );
    if (!existing) return { added: 0, removed: 0 };
    const existingSet = new Set(existing.rows.map((r) => r.ticker));
    const openSet = new Set(openSymbols);

    const toAdd = openSymbols.filter((s) => !existingSet.has(s));
    const toRemove = [...existingSet].filter((s) => !openSet.has(s));

    for (const symbol of toAdd) {
      await this._q(
        `INSERT INTO portfolio.tickers (browser_id, ticker) VALUES ($1,$2) ON CONFLICT (browser_id, ticker) DO NOTHING`,
        [PORTFOLIO_SYSTEM_BROWSER_ID, symbol]
      );
    }
    if (toRemove.length > 0) {
      await this._q(
        `DELETE FROM portfolio.tickers WHERE browser_id=$1 AND ticker = ANY($2::text[])`,
        [PORTFOLIO_SYSTEM_BROWSER_ID, toRemove]
      );
    }
    return { added: toAdd.length, removed: toRemove.length };
  }

  /** Latest TradingAgents decision for this symbol under the system watchlist, or null if not analyzed yet. */
  async getLatestAnalysis(symbol) {
    if (!this.enabled) return null;
    const r = await this._q(
      `SELECT decision, analysis_date FROM portfolio.analysis WHERE browser_id=$1 AND ticker=$2 ORDER BY analysis_date DESC LIMIT 1`,
      [PORTFOLIO_SYSTEM_BROWSER_ID, symbol]
    );
    return r && r.rowCount > 0 ? r.rows[0] : null;
  }

  /**
   * One row per (symbol, day) for currently open positions -- day-over-day % move
   * (from that day's own daily bar) plus whatever TradingAgents verdict exists as of
   * this run. Called once per open symbol per 16:00 IST run (see runner.js) so this
   * builds into a daily history over time, independent of portfolio.tickers/analysis
   * (which only ever hold the LATEST state, and get pruned when a position closes).
   */
  async saveDailySnapshot({ symbol, snapshotDate, dayChangePct, taDecision, taAnalysisDate }) {
    await this._q(
      `INSERT INTO triple_rsi.daily_snapshots (symbol, snapshot_date, day_change_pct, ta_decision, ta_analysis_date)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (symbol, snapshot_date) DO UPDATE SET
         day_change_pct=$3, ta_decision=$4, ta_analysis_date=$5`,
      [symbol, snapshotDate, dayChangePct ?? null, taDecision ?? null, taAnalysisDate ?? null]
    );
  }
}

module.exports = { DB, PORTFOLIO_SYSTEM_BROWSER_ID };
