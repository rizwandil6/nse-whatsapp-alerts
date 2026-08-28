'use strict';

/**
 * Postgres persistence for the Inside Candle Sweep+Break scanner. Same
 * graceful-degrade convention as every sibling bot in this repo (see
 * ichimoku-btc-xau-strategy/live/db.js): if neither DATABASE_URL nor
 * .secrets/pg_url.txt is set, the scanner still streams and alerts, it just
 * skips persistence and logs a warning. Own schema (inside_candle.*), same
 * shared Postgres instance as every other strategy.
 */

const fs = require('fs');
const path = require('path');
const { computeStats } = require('./stats');

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
      console.log('Postgres schema ready (inside_candle.*).');
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

  async insertSignal(e) {
    const r = await this._q(
      `INSERT INTO inside_candle.signals
         (symbol, timeframe, direction, entry_ts, entry_px, stop_px, target_px, r_value, ic_high, ic_low)
       VALUES ($1,$2,$3,to_timestamp($4/1000.0),$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [e.symbol, e.signalTf || '15m', e.direction, e.entryTs, e.entryPx, e.stop, e.target, e.r, e.icHigh, e.icLow]
    );
    if (!r || r.rowCount === 0) return null;
    const id = r.rows[0].id;
    await this._q(`INSERT INTO inside_candle.outcomes (signal_id, final_result) VALUES ($1,'OPEN')
                   ON CONFLICT (signal_id) DO NOTHING`, [id]);
    return id;
  }

  async closeOutcome(signalId, e) {
    if (signalId == null) return;
    await this._q(
      `UPDATE inside_candle.outcomes
          SET final_result=$2, exit_px=$3, r_multiple=$4, closed_ts=to_timestamp($5/1000.0), updated_at=now()
        WHERE signal_id=$1`,
      [signalId, e.result, e.exitPx, e.rMultiple, e.closedTs]
    );
  }

  /**
   * Resume support: the most recent still-open signal for a (symbol, timeframe) pair, if any
   * (survives restarts). Scoped by BOTH symbol and timeframe -- since 2026-08-28, 15m and 5m run
   * as independent trackers per symbol and can each have their own genuinely-open trade at the
   * same time; scoping by symbol alone would return only one of them and, worse, would make
   * abandonOtherOpenSignals below incorrectly abandon the other timeframe's real open trade.
   * Includes trailing_active -- see ic_engine.js#resumeTrade for why this must survive a restart.
   */
  async getOpenSignal(symbol, timeframe) {
    const r = await this._q(
      `SELECT s.id, s.symbol, s.timeframe, s.direction, s.entry_ts, s.entry_px, s.stop_px, s.target_px, s.r_value, s.trailing_active
         FROM inside_candle.signals s
         JOIN inside_candle.outcomes o ON o.signal_id = s.id
        WHERE s.symbol = $1 AND s.timeframe = $2 AND o.final_result = 'OPEN'
        ORDER BY s.entry_ts DESC
        LIMIT 1`,
      [symbol, timeframe]
    );
    if (!r || r.rowCount === 0) return null;
    return r.rows[0];
  }

  /** Floor + EMA trail (2026-08-28): mark a still-open signal as having crossed into trailing
   *  mode, so a restart mid-trail resumes correctly (see ic_engine.js#resumeTrade). */
  async activateTrailing(signalId) {
    if (signalId == null) return;
    await this._q(`UPDATE inside_candle.signals SET trailing_active = true WHERE id = $1`, [signalId]);
  }

  async getOpenSymbols() {
    const r = await this._q(
      `SELECT DISTINCT s.symbol, s.timeframe
         FROM inside_candle.signals s
         JOIN inside_candle.outcomes o ON o.signal_id = s.id
        WHERE o.final_result = 'OPEN'`
    );
    if (!r) return [];
    return r.rows.map((row) => ({ symbol: row.symbol, timeframe: row.timeframe }));
  }

  async abandonOtherOpenSignals(symbol, timeframe, keepSignalId) {
    await this._q(
      `UPDATE inside_candle.outcomes o
          SET final_result = 'ABANDONED', updated_at = now()
         FROM inside_candle.signals s
        WHERE o.signal_id = s.id AND s.symbol = $1 AND s.timeframe = $2 AND o.final_result = 'OPEN' AND s.id != $3`,
      [symbol, timeframe, keepSignalId]
    );
  }

  /** Win rate + cumulative P&L% (naive sum, per-trade %, not compounded -- same convention as
   *  the dashboard's Swing tab) across all closed (TARGET/TRAIL/SL) trades. Used to prepend live
   *  stats to every Telegram alert. Win = r_multiple >= 0 (works uniformly across result types).
   *  TRAIL added 2026-08-28 (floor-then-EMA-trail exit) -- omitting it here would silently drop
   *  every trailing-exit trade from the strategy's own reported win rate/P&L. */
  async getStats() {
    const r = await this._q(
      `SELECT s.direction, s.entry_px AS "entryPx", o.exit_px AS "exitPx", o.r_multiple AS "rMultiple"
         FROM inside_candle.signals s
         JOIN inside_candle.outcomes o ON o.signal_id = s.id
        WHERE o.final_result IN ('TARGET','TRAIL','SL')`
    );
    if (!r) return null;
    return computeStats(r.rows);
  }

  async insertAlert(a) {
    await this._q(
      `INSERT INTO inside_candle.alerts (signal_id, symbol, alert_type, chat_id, text, sent_ok)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.signalId || null, a.symbol || null, a.alertType, a.chatId || null, a.text || null, a.sentOk]
    );
  }
}

module.exports = { DB };
