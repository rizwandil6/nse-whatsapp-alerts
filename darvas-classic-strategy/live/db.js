'use strict';

/**
 * Postgres persistence for the Classic Darvas Box weekly scanner. Writes
 * per-symbol engine state (so the daily job is resumable) and the
 * forward-tracking trade/alert log described in schema.sql.
 *
 * Connection string comes from DATABASE_URL (Railway env) or, for local
 * runs, .secrets/pg_url.txt. If NEITHER is present the module degrades to
 * a no-op — the scanner still runs and sends Telegram alerts, it just
 * doesn't persist (state resets every run, which defeats the point, but
 * won't crash a local dry-run).
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
    if (!conn) { console.warn('WARNING: no DATABASE_URL / .secrets/pg_url.txt — Postgres logging DISABLED (alerts still work, but state will not persist across runs).'); return; }
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

  async loadAllState() {
    if (!this.enabled) return {};
    const r = await this._q(`SELECT symbol, state_json FROM darvas_classic.symbol_state`);
    if (!r) return {};
    const out = {};
    for (const row of r.rows) out[row.symbol] = row.state_json;
    return out;
  }

  async saveState(symbol, stateJson) {
    await this._q(
      `INSERT INTO darvas_classic.symbol_state (symbol, state_json, updated_at)
       VALUES ($1,$2,now())
       ON CONFLICT (symbol) DO UPDATE SET state_json=$2, updated_at=now()`,
      [symbol, stateJson]
    );
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

  async insertTradeEvent({ symbol, legIndex, eventType, eventDate, price, boxTop, boxBottom, trailStop, volumeRatio }) {
    await this._q(
      `INSERT INTO darvas_classic.trade_events
         (symbol, leg_index, event_type, event_date, price, box_top, box_bottom, trail_stop, volume_ratio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [symbol, legIndex, eventType, eventDate, price, boxTop ?? null, boxBottom ?? null, trailStop ?? null, volumeRatio ?? null]
    );
  }

  async insertAlert({ symbol, alertType, chatId, text, sentOk }) {
    await this._q(
      `INSERT INTO darvas_classic.alerts (symbol, alert_type, chat_id, text, sent_ok)
       VALUES ($1,$2,$3,$4,$5)`,
      [symbol || null, alertType, chatId || null, text || null, sentOk]
    );
  }
}

module.exports = { DB };
