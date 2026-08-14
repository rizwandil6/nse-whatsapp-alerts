'use strict';

/**
 * Postgres persistence for the trimmed Confluence Swing Strategy service.
 * Writes swing.signals (see swing_schema.sql).
 *
 * Connection string comes from DATABASE_URL (Railway env) or, for local runs,
 * .secrets/pg_url.txt. If NEITHER is present the module degrades to a no-op —
 * the runner still computes and logs signals, it just doesn't persist. That
 * lets the service run before the DB is wired. Mirrors pdh-pdl-strategy/live/db.js.
 *
 * NOTE: this file never contains a credential. The connection string is read
 * at runtime from env / .secrets, which the operator populates.
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

class SwingDB {
  constructor() {
    this.pool = null;
    this.enabled = false;
    const conn = resolveConnString();
    if (!conn) { console.warn('WARNING: no DATABASE_URL / .secrets/pg_url.txt — Postgres logging DISABLED (runner still computes).'); return; }
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
      const ddl = fs.readFileSync(path.join(__dirname, 'swing_schema.sql'), 'utf8');
      await this.pool.query(ddl);
      console.log('Postgres schema ready (swing.signals).');
    } catch (e) {
      console.error('schema init failed — disabling Postgres logging:', e.message);
      this.enabled = false;
    }
  }

  async _q(text, params) {
    if (!this.enabled) return null;
    try { return await this.pool.query(text, params); }
    catch (e) { console.warn('  pg query failed:', e.message); return null; }
  }

  /**
   * Upsert one signal row keyed on (symbol, signal_date). The stateless runner
   * recomputes the full picture each day, so every field is overwritten with
   * the freshly-computed value (status can advance pending -> open -> closed).
   */
  async upsertSignal(r) {
    await this._q(
      `INSERT INTO swing.signals
         (symbol, signal_date, status, entry_date, entry_px, stop_px, r_per_share, risk_pct,
          target1_px, half_date, half_price, exit_date, exit_px, r_net, since_alert_pct, last_price,
          rsi_gate_pass, rules, rs_rank_at_entry, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19, now())
       ON CONFLICT (symbol, signal_date) DO UPDATE SET
          status=EXCLUDED.status, entry_date=EXCLUDED.entry_date, entry_px=EXCLUDED.entry_px,
          stop_px=EXCLUDED.stop_px, r_per_share=EXCLUDED.r_per_share, risk_pct=EXCLUDED.risk_pct,
          target1_px=EXCLUDED.target1_px, half_date=EXCLUDED.half_date, half_price=EXCLUDED.half_price,
          exit_date=EXCLUDED.exit_date, exit_px=EXCLUDED.exit_px,
          r_net=EXCLUDED.r_net, since_alert_pct=EXCLUDED.since_alert_pct, last_price=EXCLUDED.last_price,
          rsi_gate_pass=EXCLUDED.rsi_gate_pass, rules=EXCLUDED.rules,
          rs_rank_at_entry=EXCLUDED.rs_rank_at_entry, updated_at=now()`,
      [r.symbol, r.signalDate, r.status, r.entryDate, r.entryPx, r.stopPx, r.rPerShare, r.riskPct,
       r.target1Px, r.halfDate, r.halfPrice, r.exitDate, r.exitPx, r.rNet, r.sinceAlertPct, r.lastPrice,
       r.rsiGatePass, JSON.stringify(r.rules || {}), r.rsRankAtEntry ?? null]
    );
  }

  async getOpenSignals() {
    const r = await this._q(`SELECT symbol, signal_date FROM swing.signals WHERE status IN ('open','pending')`);
    return r ? r.rows : [];
  }

  /** Snapshot of every existing row BEFORE this run's writes, for same-day transition detection. */
  async allExisting() {
    const map = new Map();
    const r = await this._q(
      `SELECT symbol, to_char(signal_date,'YYYY-MM-DD') AS signal_date, status,
              to_char(half_date,'YYYY-MM-DD') AS "halfDate", to_char(exit_date,'YYYY-MM-DD') AS "exitDate",
              rs_rank_at_entry
       FROM swing.signals`
    );
    for (const row of r ? r.rows : []) map.set(`${row.symbol}|${row.signal_date}`, row);
    return map;
  }

  async close() { if (this.pool) await this.pool.end(); }
}

module.exports = { SwingDB };
