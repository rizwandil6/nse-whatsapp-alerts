'use strict';

/**
 * Postgres persistence for the Ichimoku BTC/XAU MTF scanner. Same graceful-
 * degrade convention as every sibling bot in this repo (see
 * pdh-pdl-strategy/live/db.js, ichimoku-momentum-strategy/live/db.js): if
 * neither DATABASE_URL nor .secrets/pg_url.txt is set, the scanner still
 * streams and alerts, it just skips persistence and logs a warning.
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
    if (!conn) { console.warn('WARNING: no DATABASE_URL / .secrets/pg_url.txt -- Postgres logging DISABLED (alerts still work).'); return; }
    if (!Pool) { console.warn('WARNING: pg module not installed -- Postgres logging DISABLED. Run `npm install`.'); return; }
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
      console.log('Postgres schema ready (ichimoku_btcxau.*).');
    } catch (e) {
      console.error('FATAL-ish: schema init failed -- disabling Postgres logging:', e.message);
      this.enabled = false;
    }
  }

  async _q(text, params) {
    if (!this.enabled) return null;
    try { return await this.pool.query(text, params); }
    catch (e) { console.warn('  pg query failed:', e.message); return null; }
  }

  async insertSignal(e, stopBufferPct) {
    const r = await this._q(
      `INSERT INTO ichimoku_btcxau.signals
         (symbol, direction, entry_ts, entry_px, stop_px, target_px, r_value, ema200_at_entry, stop_buffer_pct, criteria)
       VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [e.symbol, e.direction, e.entryTs, e.entryPx, e.stop, e.target, e.r, e.ema200At, stopBufferPct, JSON.stringify(e.criteria || {})]
    );
    if (!r || r.rowCount === 0) return null;
    const id = r.rows[0].id;
    await this._q(`INSERT INTO ichimoku_btcxau.outcomes (signal_id, final_result) VALUES ($1,'OPEN')
                   ON CONFLICT (signal_id) DO NOTHING`, [id]);
    return id;
  }

  async markWarning(signalId, ts) {
    if (signalId == null) return;
    await this._q(
      `UPDATE ichimoku_btcxau.outcomes SET warning_fired=true, warning_ts=to_timestamp($2/1000.0), updated_at=now()
       WHERE signal_id=$1 AND warning_fired=false`,
      [signalId, ts]
    );
  }

  async closeOutcome(signalId, e) {
    if (signalId == null) return;
    await this._q(
      `UPDATE ichimoku_btcxau.outcomes
          SET final_result=$2, exit_px=$3, r_multiple=$4, mfe_r=$5, mae_r=$6, closed_ts=to_timestamp($7/1000.0), updated_at=now()
        WHERE signal_id=$1`,
      [signalId, e.result, e.exitPx, e.rMultiple, e.mfeR, e.maeR, e.closedTs]
    );
  }

  /** Resume support: the most recent still-open signal for a symbol, if any (survives restarts). */
  async getOpenSignal(symbol) {
    const r = await this._q(
      `SELECT s.id, s.symbol, s.direction, s.entry_ts, s.entry_px, s.stop_px, s.target_px,
              s.r_value, s.ema200_at_entry, s.criteria, o.warning_fired
         FROM ichimoku_btcxau.signals s
         JOIN ichimoku_btcxau.outcomes o ON o.signal_id = s.id
        WHERE s.symbol = $1 AND o.final_result = 'OPEN'
        ORDER BY s.entry_ts DESC
        LIMIT 1`,
      [symbol]
    );
    if (!r || r.rowCount === 0) return null;
    return r.rows[0];
  }

  /** Restart hygiene: if more than one OPEN row exists for a symbol (a pre-fix restart artifact),
   *  keep the one being resumed and flag the rest ABANDONED so they stop polluting outcome stats. */
  async abandonOtherOpenSignals(symbol, keepSignalId) {
    await this._q(
      `UPDATE ichimoku_btcxau.outcomes o
          SET final_result = 'ABANDONED', updated_at = now()
         FROM ichimoku_btcxau.signals s
        WHERE o.signal_id = s.id AND s.symbol = $1 AND o.final_result = 'OPEN' AND s.id != $2`,
      [symbol, keepSignalId]
    );
  }

  async insertAlert(a) {
    await this._q(
      `INSERT INTO ichimoku_btcxau.alerts (signal_id, symbol, alert_type, chat_id, text, sent_ok)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.signalId || null, a.symbol || null, a.alertType, a.chatId || null, a.text || null, a.sentOk]
    );
  }
}

module.exports = { DB };
