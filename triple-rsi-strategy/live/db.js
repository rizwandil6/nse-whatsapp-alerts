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
}

module.exports = { DB };
