'use strict';

/**
 * Postgres persistence for the Sabbal Stick monitor -- fully independent of
 * darvasbox_db.js (own schema `sabbal`, own pool), same fail-open posture:
 * if DATABASE_URL / pg aren't available, the monitor keeps running and
 * alerting on Telegram, it just loses cross-restart position memory for
 * that stretch. See darvasbox_db.js's docstring for the reasoning this
 * mirrors and the incident (2026-08-11 dual-instance redeploy) that makes
 * the ON CONFLICT DO NOTHING dedup non-optional.
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

class SabbalDB {
  constructor() {
    this.pool = null;
    this.enabled = false;
    const conn = resolveConnString();
    if (!conn) { console.warn('WARNING: no DATABASE_URL / .secrets/pg_url.txt -- Sabbal Stick Postgres logging DISABLED (alerts still work, no cross-restart position memory).'); return; }
    if (!Pool) { console.warn('WARNING: pg module not installed -- Sabbal Stick Postgres logging DISABLED.'); return; }
    const useSsl = /railway|render|amazonaws|neon\.tech/.test(conn) && process.env.PGSSL !== 'disable';
    this.pool = new Pool({ connectionString: conn, ssl: useSsl ? { rejectUnauthorized: false } : undefined });
    this.enabled = true;
  }

  async ensureSchema() {
    if (!this.enabled) return;
    const sql = fs.readFileSync(path.join(__dirname, 'sabbal_schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  async loadOpenPositions() {
    if (!this.enabled) return {};
    const { rows } = await this.pool.query('SELECT * FROM sabbal.open_positions');
    const out = {};
    for (const r of rows) {
      out[r.symbol] = {
        direction: r.direction,
        entryTs: r.entry_ts,
        entryPx: Number(r.entry_px),
        slPx: Number(r.sl_px),
        targetPx: Number(r.target_px),
      };
    }
    return out;
  }

  async recordEntry({ symbol, direction, entryTs, entryPx, slPx, targetPx, tradeDate }) {
    if (!this.enabled) return true;
    try {
      await this.pool.query(
        `INSERT INTO sabbal.trade_events (event_type, symbol, direction, entry_ts, entry_px, sl_px, target_px, trade_date)
         VALUES ('ENTRY', $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [symbol, direction, entryTs, entryPx, slPx, targetPx, tradeDate]
      );
      await this.pool.query(
        `INSERT INTO sabbal.open_positions (symbol, direction, entry_ts, entry_px, sl_px, target_px, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (symbol) DO UPDATE SET direction=$2, entry_ts=$3, entry_px=$4, sl_px=$5, target_px=$6, updated_at=now()`,
        [symbol, direction, entryTs, entryPx, slPx, targetPx]
      );
      return true;
    } catch (e) {
      console.error('sabbal_db recordEntry failed:', e.message);
      return false;
    }
  }

  async recordExit({ symbol, direction, entryTs, entryPx, slPx, targetPx, exitTs, exitPx, exitReason, pnlPct, tradeDate }) {
    if (!this.enabled) return true;
    try {
      await this.pool.query(
        `INSERT INTO sabbal.trade_events (event_type, symbol, direction, entry_ts, entry_px, sl_px, target_px, exit_ts, exit_px, exit_reason, pnl_pct, trade_date)
         VALUES ('EXIT', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT DO NOTHING`,
        [symbol, direction, entryTs, entryPx, slPx, targetPx, exitTs, exitPx, exitReason, pnlPct, tradeDate]
      );
      await this.pool.query('DELETE FROM sabbal.open_positions WHERE symbol = $1', [symbol]);
      return true;
    } catch (e) {
      console.error('sabbal_db recordExit failed:', e.message);
      return false;
    }
  }
}

module.exports = { SabbalDB };
