'use strict';

/**
 * Trade log for the A/B variant experiment (anti-chase, 2% SL -- see
 * variant_tracker.js's module docstring). Backed by Postgres
 * (darvasbox_db.js/darvasbox_schema.sql), discriminated from the real
 * tracker's events by tracker='variant' in the same trade_events table --
 * see trade_log.js and darvasbox_db.js for why this replaced GitHub-branch
 * JSON logging.
 */

const CONFIG_TAG = 'darvasbox-variant-antichase-eodstop';

/** Returns { inserted, id }. inserted:false means this exact event already
 * exists -- callers gate the variant's Telegram alert on this. */
async function recordEvent(db, event, tradeDateStr) {
  return db.insertTradeEvent('variant', CONFIG_TAG, event, tradeDateStr);
}

module.exports = { CONFIG_TAG, recordEvent };
