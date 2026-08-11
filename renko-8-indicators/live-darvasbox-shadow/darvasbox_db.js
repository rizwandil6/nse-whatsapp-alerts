'use strict';

/**
 * Postgres persistence for DarvasBox trade events (real/shadow tracker +
 * variant tracker) and their open-position state. Replaces the old
 * GitHub-branch JSON logging (trade_log.js/variant_log.js/tracked_state.js/
 * variant_tracked_state.js), which was vulnerable to a real incident: a
 * Railway auto-redeploy briefly running two live instances, each
 * independently writing its own ENTRY/EXIT for the same trade with no way
 * to detect the collision. Here, dedup is a DB-level unique index (see
 * darvasbox_schema.sql) with INSERT ... ON CONFLICT DO NOTHING -- a racing
 * duplicate insert is a safe no-op instead of a corrupted double-write.
 *
 * Connection string comes from DATABASE_URL (Railway env) or, for local
 * runs, .secrets/pg_url.txt. If neither is present, or the `pg` module
 * isn't installed, the module degrades to a no-op -- the bot keeps trading
 * and alerting, it just loses persistence/dedup for that stretch. Same
 * fail-open posture as pdhpdl_db.js.
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

class DarvasDB {
  constructor() {
    this.pool = null;
    this.enabled = false;
    const conn = resolveConnString();
    if (!conn) { console.warn('WARNING: no DATABASE_URL / .secrets/pg_url.txt — DarvasBox Postgres logging DISABLED (trading/alerts still work).'); return; }
    if (!Pool) { console.warn('WARNING: pg module not installed — DarvasBox Postgres logging DISABLED. Run `npm install`.'); return; }
    const isLocal = /localhost|127\.0\.0\.1/.test(conn);
    const ssl = process.env.PGSSL === 'disable' || isLocal ? false : { rejectUnauthorized: false };
    this.pool = new Pool({ connectionString: conn, ssl, max: 4 });
    this.pool.on('error', (e) => console.warn('  darvasbox pg pool error:', e.message));
    this.enabled = true;
  }

  async init() {
    if (!this.enabled) return;
    try {
      const ddl = fs.readFileSync(path.join(__dirname, 'darvasbox_schema.sql'), 'utf8');
      await this.pool.query(ddl);
      console.log('Postgres schema ready (darvasbox.*).');
    } catch (e) {
      console.error('FATAL-ish: darvasbox schema init failed — disabling Postgres logging:', e.message);
      this.enabled = false;
    }
  }

  async _q(text, params) {
    if (!this.enabled) return null;
    try { return await this.pool.query(text, params); }
    catch (e) { console.warn('  darvasbox pg query failed:', e.message); return null; }
  }

  /**
   * Inserts an ENTRY or EXIT event. Returns { inserted, id }. `inserted:
   * false` means the unique index fired -- this exact event (by
   * tracker+symbol+direction+timestamps+action) already exists, whether
   * from this process or a racing sibling instance; callers use this in
   * place of the old isDuplicateEvent()/recordTrade() boolean.
   *
   * Fails open (inserted:true, id:null) when the DB is disabled or the
   * query errors, so a Postgres outage never blocks trading or alerting --
   * it just loses the dedup safety net for that stretch, same posture as
   * a dropped GitHub push today.
   */
  async insertTradeEvent(tracker, configTag, e, tradeDateStr) {
    if (!this.enabled) return { inserted: true, id: null };
    const isEntry = e.type === 'ENTRY';
    const text = isEntry
      ? `INSERT INTO darvasbox.trade_events
           (tracker, config_tag, event_type, symbol, direction, entry_ts,
            entry_px, theoretical_entry_px, live_price_available, brick_pct, payload, trade_date)
         VALUES ($1,$2,'ENTRY',$3,$4,to_timestamp($5/1000.0),$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tracker, symbol, direction, entry_ts) WHERE event_type='ENTRY' DO NOTHING
         RETURNING id`
      : `INSERT INTO darvasbox.trade_events
           (tracker, config_tag, event_type, symbol, direction, action, entry_ts, exit_ts,
            entry_px, exit_px, theoretical_exit_px, live_price_available, brick_pct, bars_held, pnl_pct, payload, trade_date)
         VALUES ($1,$2,'EXIT',$3,$4,$5,to_timestamp($6/1000.0),to_timestamp($7/1000.0),
                 $8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (tracker, symbol, direction, action, entry_ts, exit_ts) WHERE event_type='EXIT' DO NOTHING
         RETURNING id`;
    const params = isEntry
      ? [tracker, configTag, e.symbol, e.direction, e.timestampMs, e.entry, e.theoreticalEntry, e.livePriceAvailable, e.brickPct, e, tradeDateStr]
      : [tracker, configTag, e.symbol, e.direction, e.action, e.entryTimestampMs, e.exitTimestampMs, e.entry, e.exitPrice, e.theoreticalExit, e.livePriceAvailable, e.brickPct, e.barsHeld, e.pnlPct, e, tradeDateStr];
    const r = await this._q(text, params);
    if (!r) return { inserted: true, id: null };
    return { inserted: r.rowCount > 0, id: r.rowCount ? r.rows[0].id : null };
  }

  /** Upsert current position snapshot for one symbol. position=null clears it (flat). */
  async saveTrackedState(tracker, symbol, position) {
    await this._q(
      `INSERT INTO darvasbox.tracked_state (tracker, symbol, position, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (tracker, symbol) DO UPDATE SET position = EXCLUDED.position, updated_at = now()`,
      [tracker, symbol, position]
    );
  }

  /** Bulk upsert matching the old "rewrite whole snapshot every event" call pattern. */
  async saveAllTrackedState(tracker, trackersMap) {
    for (const [symbol, t] of Object.entries(trackersMap)) {
      await this.saveTrackedState(tracker, symbol, t.toJSON().position || null);
    }
  }

  /** Returns { [symbol]: { position } }, matching the old file-based loadTrackedState()'s shape. */
  async loadTrackedState(tracker) {
    const out = {};
    const r = await this._q(`SELECT symbol, position FROM darvasbox.tracked_state WHERE tracker=$1`, [tracker]);
    if (r) for (const row of r.rows) out[row.symbol] = { position: row.position };
    return out;
  }

  /** Replaces getTodaysExits(dateStr, istDateStrFn) -- filtering now happens in SQL via trade_date. */
  async getTodaysExits(tracker, tradeDateStr) {
    const r = await this._q(
      `SELECT payload FROM darvasbox.trade_events
       WHERE tracker=$1 AND event_type='EXIT' AND trade_date=$2 ORDER BY exit_ts`,
      [tracker, tradeDateStr]
    );
    return r ? r.rows.map((row) => row.payload) : [];
  }
}

module.exports = { DarvasDB };
