'use strict';

/**
 * Trade log for the 0.25%-brick / flat-1%-stop / LTP-confirmed DarvasBox
 * shadow trade. Backed by Postgres (darvasbox_db.js/darvasbox_schema.sql),
 * not GitHub -- see that module's docstring for why: a Railway auto-redeploy
 * mid-session can briefly run two live instances, and a DB-level unique
 * index makes a racing duplicate write a safe no-op instead of a corrupted
 * double-entry (confirmed live 2026-08-11 on the variant tracker before
 * this migration).
 *
 * `db` is passed in explicitly (the darvasboxDb instance streamer.js already
 * owns), matching this repo's existing style (pdhpdlDb is used the same way).
 */

const CONFIG_TAG = 'darvasbox-shadow-0.25pct-1pctSL';

/** Returns { inserted, id }. inserted:false means this exact event already
 * exists (this process or a racing sibling instance) -- callers use this in
 * place of the old isDuplicateEvent()/recordTrade() boolean. */
async function recordEvent(db, event, tradeDateStr) {
  return db.insertTradeEvent('real', CONFIG_TAG, event, tradeDateStr);
}

/** Rebuilds today's already-recorded EXIT events -- used at startup to
 * restore the in-memory running day-total (dayStats in streamer.js) after
 * any restart. tradeDateStr = IST calendar date (bar_aggregator.js's
 * istDateStr format). */
async function getTodaysExits(db, tradeDateStr) {
  return db.getTodaysExits('real', tradeDateStr);
}

module.exports = { CONFIG_TAG, recordEvent, getTodaysExits };
