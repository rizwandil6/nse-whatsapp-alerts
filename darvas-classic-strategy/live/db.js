'use strict';

/**
 * Postgres persistence for the Classic Darvas Box weekly scanner. Writes the
 * daily-candle cache and one row per position (open or closed) -- see
 * schema.sql. No alert log: this service doesn't push to Telegram, it's a
 * plain forward-tracking dataset for the dashboard tab (same spirit as
 * swing.signals).
 *
 * Connection string comes from DATABASE_URL (Railway env) or, for local
 * runs, .secrets/pg_url.txt. If NEITHER is present the module degrades to
 * a no-op -- the scanner still computes trade logs, it just doesn't persist.
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
      console.log('Postgres schema ready (darvas_classic.*).');
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
    const r = await this._q(`SELECT daily_bars_json FROM darvas_classic.daily_cache WHERE symbol=$1`, [symbol]);
    if (!r || r.rowCount === 0) return null;
    return r.rows[0].daily_bars_json;
  }

  async saveDailyBars(symbol, dailyBars) {
    await this._q(
      `INSERT INTO darvas_classic.daily_cache (symbol, daily_bars_json, updated_at)
       VALUES ($1,$2,now())
       ON CONFLICT (symbol) DO UPDATE SET daily_bars_json=$2, updated_at=now()`,
      [symbol, JSON.stringify(dailyBars)]
    );
  }

  async replaceWatchlist(rows) {
    if (!this.enabled) return;
    await this._q('TRUNCATE darvas_classic.watchlist');
    for (const r of rows) {
      await this._q(
        `INSERT INTO darvas_classic.watchlist (symbol, box_top, box_bottom, trigger_price, avg_volume, last_price, distance_pct, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [r.symbol, r.boxTop, r.boxBottom, r.triggerPrice, r.avgVolume ?? null, r.lastPrice ?? null, r.distancePct ?? null]
      );
    }
  }

  async getWatchlist() {
    if (!this.enabled) return [];
    const r = await this._q('SELECT symbol, box_top, box_bottom, trigger_price, avg_volume FROM darvas_classic.watchlist');
    return r ? r.rows : [];
  }

  async hasAlertedThisWeek(symbol, weekStart) {
    if (!this.enabled) return false;
    const r = await this._q(
      'SELECT 1 FROM darvas_classic.watchlist_alerts WHERE symbol=$1 AND week_start=$2',
      [symbol, weekStart]
    );
    return !!(r && r.rowCount > 0);
  }

  async recordWatchlistAlert({ symbol, weekStart, alertPrice, volumeRatio }) {
    await this._q(
      `INSERT INTO darvas_classic.watchlist_alerts (symbol, week_start, alert_price, volume_ratio)
       VALUES ($1,$2,$3,$4) ON CONFLICT (symbol, week_start) DO NOTHING`,
      [symbol, weekStart, alertPrice, volumeRatio]
    );
  }

  async upsertPosition({ symbol, entryDate, entryPrice, status, legs, legsJson, trailStop, exitDate, exitPrice, exitReason, lastPrice, pnlPct }) {
    await this._q(
      `INSERT INTO darvas_classic.positions
         (symbol, entry_date, entry_price, status, legs, legs_json, trail_stop, exit_date, exit_price, exit_reason, last_price, pnl_pct, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (symbol, entry_date) DO UPDATE SET
         entry_price=$3, status=$4, legs=$5, legs_json=$6, trail_stop=$7,
         exit_date=$8, exit_price=$9, exit_reason=$10, last_price=$11, pnl_pct=$12, updated_at=now()`,
      [symbol, entryDate, entryPrice, status, legs, JSON.stringify(legsJson), trailStop ?? null,
        exitDate ?? null, exitPrice ?? null, exitReason ?? null, lastPrice ?? null, pnlPct ?? null]
    );
  }
}

module.exports = { DB };
