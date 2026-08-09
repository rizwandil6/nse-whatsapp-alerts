'use strict';

/**
 * Postgres persistence for RS Momentum's per-symbol status -- upserts ONE row per
 * symbol into rs_momentum_status (same Railway Postgres addon the Java dashboard's
 * quarterly_results table lives in), replacing the old append-only
 * rs_momentum_log.json, which grew a new row per symbol on every daily run instead
 * of updating the existing one. Same connection/degrade-gracefully pattern as
 * pdh-pdl-strategy/live/db.js: if DATABASE_URL isn't set, this becomes a no-op and
 * the daily run still completes (Telegram alerts + JSON state files untouched).
 */

const fs = require('fs');
const path = require('path');

let Pool = null;
try { ({ Pool } = require('pg')); } catch (_) { /* pg not installed yet */ }

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS rs_momentum_status (
    symbol            TEXT PRIMARY KEY,
    company_name      TEXT,
    status            TEXT NOT NULL,
    event_date        DATE,
    price             NUMERIC,
    rs_rank_at_entry  NUMERIC,
    sales_growth_3y   NUMERIC,
    pnl_pct           NUMERIC,
    modified_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

function resolveConnString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  const p = path.join(__dirname, '..', '..', '.secrets', 'pg_url.txt');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  return null;
}

class RsMomentumDb {
  constructor() {
    this.pool = null;
    this.enabled = false;
    const conn = resolveConnString();
    if (!conn) { console.warn('WARNING: no DATABASE_URL / .secrets/pg_url.txt -- rs_momentum_status persistence DISABLED (JSON state/alerts still work).'); return; }
    if (!Pool) { console.warn('WARNING: pg module not installed -- rs_momentum_status persistence DISABLED. Run `npm install`.'); return; }
    const isLocal = /localhost|127\.0\.0\.1/.test(conn);
    const ssl = process.env.PGSSL === 'disable' || isLocal ? false : { rejectUnauthorized: false };
    this.pool = new Pool({ connectionString: conn, ssl, max: 4 });
    this.pool.on('error', (e) => console.warn('  rs_momentum_status pg pool error:', e.message));
    this.enabled = true;
  }

  async init() {
    if (!this.enabled) return;
    try {
      await this.pool.query(CREATE_TABLE_SQL);
      console.log('Postgres schema ready (rs_momentum_status).');
    } catch (e) {
      console.error('rs_momentum_status schema init failed -- disabling persistence:', e.message);
      this.enabled = false;
    }
  }

  /** Upserts the CURRENT status for one symbol -- never appends, so a symbol that
   * cycles ENTRY -> EXIT -> (new) ENTRY still shows as exactly one row, just with
   * modified_at bumped to now (which is what the dashboard sorts by). */
  async upsertStatus(entry) {
    if (!this.enabled) return;
    try {
      await this.pool.query(
        `INSERT INTO rs_momentum_status
           (symbol, company_name, status, event_date, price, rs_rank_at_entry, sales_growth_3y, pnl_pct, modified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (symbol) DO UPDATE SET
           company_name = COALESCE(EXCLUDED.company_name, rs_momentum_status.company_name),
           status = EXCLUDED.status,
           event_date = EXCLUDED.event_date,
           price = EXCLUDED.price,
           rs_rank_at_entry = EXCLUDED.rs_rank_at_entry,
           sales_growth_3y = EXCLUDED.sales_growth_3y,
           pnl_pct = EXCLUDED.pnl_pct,
           modified_at = now()`,
        [entry.symbol, entry.companyName || null, entry.status, entry.date || null,
         entry.price ?? null, entry.rsRankAtEntry ?? null, entry.salesGrowth3Y ?? null, entry.pnlPct ?? null]
      );
    } catch (e) {
      console.warn(`  rs_momentum_status upsert failed for ${entry.symbol}:`, e.message);
    }
  }
}

module.exports = { RsMomentumDb };
