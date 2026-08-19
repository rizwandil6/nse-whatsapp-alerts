'use strict';

/**
 * Postgres persistence for the Opening Loser Short scanner. Writes the
 * forward-tracking dataset (signals / outcomes / alerts) described in
 * schema.sql.
 *
 * Connection string comes from DATABASE_URL (Railway env) or, for local
 * runs, .secrets/pg_url.txt. If NEITHER is present the module degrades to
 * a no-op — the scanner still streams and sends Telegram alerts, it just
 * doesn't persist.
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
    if (!conn) { console.warn('WARNING: no DATABASE_URL / .secrets/pg_url.txt — Postgres logging DISABLED (alerts still work).'); return; }
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
      console.log('Postgres schema ready (opening_loser_short.*).');
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

  async insertSignal({ symbol, tradeDate, prevClose, openPctChange, entryTs, entryPx }) {
    const r = await this._q(
      `INSERT INTO opening_loser_short.signals (symbol, trade_date, prev_close, open_pct_change, entry_ts, entry_px)
       VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),$6)
       ON CONFLICT (trade_date) DO NOTHING
       RETURNING id`,
      [symbol, tradeDate, prevClose, openPctChange, entryTs, entryPx]
    );
    if (!r || r.rowCount === 0) return null;
    const id = r.rows[0].id;
    await this._q(`INSERT INTO opening_loser_short.outcomes (signal_id) VALUES ($1)
                   ON CONFLICT (signal_id) DO NOTHING`, [id]);
    return id;
  }

  async closeOutcome(signalId, { exitTs, exitPx, exitReason, pnlPct, result }) {
    if (signalId == null) return;
    await this._q(
      `UPDATE opening_loser_short.outcomes
          SET exit_ts=to_timestamp($2/1000.0), exit_px=$3, exit_reason=$4, pnl_pct=$5, result=$6, updated_at=now()
        WHERE signal_id=$1`,
      [signalId, exitTs, exitPx, exitReason, pnlPct, result]
    );
  }

  async insertAlert({ signalId, symbol, alertType, chatId, text, sentOk }) {
    await this._q(
      `INSERT INTO opening_loser_short.alerts (signal_id, symbol, alert_type, chat_id, text, sent_ok)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [signalId || null, symbol || null, alertType, chatId || null, text || null, sentOk]
    );
  }
}

module.exports = { DB };
