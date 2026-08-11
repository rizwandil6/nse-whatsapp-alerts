'use strict';

// trade_log.js used to own an in-process `eventKey()` dedup check against a
// local JSON file; that logic moved into darvasbox_schema.sql's partial
// unique indexes (see darvasbox_db.js), which is what actually fixed the
// 2026-08-11 incident (a Railway redeploy briefly running two live
// instances, each writing its own duplicate ENTRY/EXIT). These tests now
// cover trade_log.js's remaining job: delegating to the shared DarvasDB
// instance with the right tracker/config-tag identity. See
// darvasbox_db.test.js for the price-invariance property (two events
// differing only in price must bind identical values to the DB's conflict
// target) that used to be exercised via eventKey() directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONFIG_TAG, recordEvent, getTodaysExits } = require('./trade_log');

function fakeDb() {
  const calls = { insertTradeEvent: [], getTodaysExits: [] };
  return {
    calls,
    async insertTradeEvent(tracker, configTag, event, tradeDateStr) {
      calls.insertTradeEvent.push({ tracker, configTag, event, tradeDateStr });
      return { inserted: true, id: 1 };
    },
    async getTodaysExits(tracker, tradeDateStr) {
      calls.getTodaysExits.push({ tracker, tradeDateStr });
      return [];
    },
  };
}

test('recordEvent tags events with tracker=real and the shadow config tag', async () => {
  const db = fakeDb();
  const entry = { type: 'ENTRY', symbol: 'ORIENTELEC', direction: 'SHORT', entry: 173.4, timestampMs: 1785491700000 };
  const result = await recordEvent(db, entry, '2026-08-11');
  assert.deepEqual(result, { inserted: true, id: 1 });
  assert.equal(db.calls.insertTradeEvent.length, 1);
  assert.equal(db.calls.insertTradeEvent[0].tracker, 'real');
  assert.equal(db.calls.insertTradeEvent[0].configTag, CONFIG_TAG);
  assert.equal(db.calls.insertTradeEvent[0].event, entry);
  assert.equal(db.calls.insertTradeEvent[0].tradeDateStr, '2026-08-11');
});

test('getTodaysExits queries tracker=real for the given date', async () => {
  const db = fakeDb();
  await getTodaysExits(db, '2026-08-11');
  assert.deepEqual(db.calls.getTodaysExits, [{ tracker: 'real', tradeDateStr: '2026-08-11' }]);
});
