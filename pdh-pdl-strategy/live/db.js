'use strict';

/**
 * Postgres persistence for the PDH/PDL scanner. Writes the forward-tracking
 * dataset (armed / signals / outcomes / alerts) described in schema.sql.
 *
 * Connection string comes from DATABASE_URL (Railway env) or, for local runs,
 * .secrets/pg_url.txt. If NEITHER is present the module degrades to a no-op —
 * the scanner still streams and sends Telegram alerts, it just doesn't
 * persist. That lets the service run before the DB is wired.
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
      console.log('Postgres schema ready (pdh_pdl.*).');
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

  // --- writes -------------------------------------------------------------
  async insertArmed(e, tradeDate) {
    await this._q(
      `INSERT INTO pdh_pdl.armed (symbol, trade_date, direction, level_type, level, break_ts, break_close)
       VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7)
       ON CONFLICT (symbol, trade_date) DO NOTHING`,
      [e.symbol, tradeDate, e.direction, e.levelType, e.level, e.breakTs, e.breakClose]
    );
  }

  async insertSignal(e, tradeDate) {
    const r = await this._q(
      `INSERT INTO pdh_pdl.signals
         (symbol, trade_date, direction, pdh, pdl, level, level_type, break_ts, entry_ts,
          entry_px, sl, r_value, t_1p5, t_2r, t_3r, trigger_type, efficiency_ratio, in_window)
       VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),to_timestamp($9/1000.0),
               $10,$11,$12,$13,$14,$15,$16,$17,true)
       ON CONFLICT (symbol, trade_date) DO NOTHING
       RETURNING id`,
      [e.symbol, tradeDate, e.direction, e.pdh, e.pdl, e.level, e.levelType, e.breakTs,
       e.entryTs, e.entryPx, e.sl, e.r, e.t1p5, e.t2, e.t3, e.triggerType, e.effRatio]
    );
    if (!r || r.rowCount === 0) return null;
    const id = r.rows[0].id;
    await this._q(`INSERT INTO pdh_pdl.outcomes (signal_id, final_result) VALUES ($1,'OPEN')
                   ON CONFLICT (signal_id) DO NOTHING`, [id]);
    await this._q(`UPDATE pdh_pdl.armed SET led_to_setup = true WHERE symbol=$1 AND trade_date=$2`,
      [e.symbol, tradeDate]);
    return id;
  }

  async markMilestone(signalId, level, ts) {
    if (signalId == null) return;
    const col = level === 'T1.5R' ? 'hit_1p5_ts' : level === 'T2R' ? 'hit_2r_ts' : null;
    if (!col) return;
    await this._q(`UPDATE pdh_pdl.outcomes SET ${col}=to_timestamp($2/1000.0), updated_at=now()
                   WHERE signal_id=$1 AND ${col} IS NULL`, [signalId, ts]);
  }

  async closeOutcome(signalId, e) {
    if (signalId == null) return;
    const slCol = e.result === 'SL' ? 'to_timestamp($7/1000.0)' : 'hit_sl_ts';
    await this._q(
      `UPDATE pdh_pdl.outcomes
          SET final_result=$2, exit_px=$3, r_multiple=$4, mfe_r=$5, mae_r=$6,
              closed_ts=to_timestamp($7/1000.0), hit_3r_ts=CASE WHEN $2='T3R' THEN to_timestamp($7/1000.0) ELSE hit_3r_ts END,
              hit_sl_ts=${slCol}, updated_at=now()
        WHERE signal_id=$1`,
      [signalId, e.result, e.exitPx, e.rMultiple, e.mfeR, e.maeR, e.closedTs]
    );
  }

  async insertAlert(a) {
    await this._q(
      `INSERT INTO pdh_pdl.alerts (signal_id, symbol, alert_type, chat_id, text, sent_ok)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.signalId || null, a.symbol || null, a.alertType, a.chatId || null, a.text || null, a.sentOk]
    );
  }
}

module.exports = { DB };
