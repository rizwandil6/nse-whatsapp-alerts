'use strict';

// No real Postgres in CI for this repo (confirmed: no existing test-DB
// harness/convention, e.g. pdhpdl_engine.test.js doesn't touch a DB either).
// These tests cover the degrade-safe no-DB-configured path -- the same
// posture pdhpdl_db.js relies on to let the bot run before/without a DB.
// The actual dedup guarantee (the real fix for the 2026-08-11 incident) is
// enforced by darvasbox_schema.sql's partial unique indexes; verifying that
// requires a real Postgres instance and two concurrent inserts racing each
// other -- add that as an integration test if/when a TEST_DATABASE_URL
// convention gets added to this repo.

const test = require('node:test');
const assert = require('node:assert/strict');

test('DarvasDB with no DATABASE_URL: enabled=false, never throws', async () => {
  delete process.env.DATABASE_URL;
  delete require.cache[require.resolve('./darvasbox_db')];
  const { DarvasDB } = require('./darvasbox_db');
  const db = new DarvasDB();
  assert.equal(db.enabled, false);

  await assert.doesNotReject(db.init());

  const entry = { type: 'ENTRY', symbol: 'NHPC', direction: 'LONG', entry: 78.85, theoreticalEntry: 78.8, timestampMs: 1, livePriceAvailable: true, brickPct: '0.25' };
  const result = await db.insertTradeEvent('real', 'darvasbox-shadow-0.25pct-1pctSL', entry, '2026-08-11');
  // Fail-open: DB unavailable never blocks trading -- treated as "not a duplicate".
  assert.deepEqual(result, { inserted: true, id: null });

  await assert.doesNotReject(db.saveTrackedState('real', 'NHPC', { direction: 'LONG', entry: 78.85 }));
  await assert.doesNotReject(db.saveAllTrackedState('real', {}));

  assert.deepEqual(await db.loadTrackedState('real'), {});
  assert.deepEqual(await db.getTodaysExits('real', '2026-08-11'), []);
});

// Ports the intent of the old eventKey() tests (trade_log.js, pre-migration):
// two events for the same trade that differ ONLY in price must bind
// identical values to the columns the DB's partial unique index conflicts
// on, so a racing duplicate insert (the real 2026-08-11 incident) collides
// and no-ops instead of creating a second row. We can't hit real Postgres in
// this repo's CI (see file docstring), so this inspects the query/params
// insertTradeEvent actually builds via a fake pool, rather than the
// ON CONFLICT behavior itself.
test('insertTradeEvent: ENTRY conflict-target params are identical for two fills at different prices', async () => {
  delete require.cache[require.resolve('./darvasbox_db')];
  const { DarvasDB } = require('./darvasbox_db');
  const db = new DarvasDB();
  db.enabled = true;
  const queries = [];
  db.pool = { query: async (text, params) => { queries.push({ text, params }); return { rowCount: 1, rows: [{ id: 1 }] }; } };

  const original = { type: 'ENTRY', symbol: 'ORIENTELEC', direction: 'SHORT', entry: 173.4, theoreticalEntry: 173.0, timestampMs: 1785491700000, livePriceAvailable: true, brickPct: '0.25' };
  const replayed = { type: 'ENTRY', symbol: 'ORIENTELEC', direction: 'SHORT', entry: 174.213375, theoreticalEntry: 173.0, timestampMs: 1785491700000, livePriceAvailable: true, brickPct: '0.25' };
  await db.insertTradeEvent('real', 'darvasbox-shadow-0.25pct-1pctSL', original, '2026-08-11');
  await db.insertTradeEvent('real', 'darvasbox-shadow-0.25pct-1pctSL', replayed, '2026-08-11');

  // ON CONFLICT (tracker, symbol, direction, entry_ts) -- params[0,2,3,4].
  const conflictParams = (p) => [p[0], p[2], p[3], p[4]];
  assert.deepEqual(conflictParams(queries[0].params), conflictParams(queries[1].params));
  // Sanity: the events genuinely differ (price did change) -- this isn't a no-op test.
  assert.notEqual(queries[0].params[5], queries[1].params[5]);
});

test('insertTradeEvent: EXIT conflict-target params still discriminate different actions', async () => {
  delete require.cache[require.resolve('./darvasbox_db')];
  const { DarvasDB } = require('./darvasbox_db');
  const db = new DarvasDB();
  db.enabled = true;
  const queries = [];
  db.pool = { query: async (text, params) => { queries.push({ text, params }); return { rowCount: 1, rows: [{ id: 1 }] }; } };

  const cross = { type: 'EXIT', symbol: 'TITAGARH', direction: 'LONG', action: 'EMA_9_20_CROSS', entry: 1, exitPrice: 2, entryTimestampMs: 1, exitTimestampMs: 2 };
  const eod = { type: 'EXIT', symbol: 'TITAGARH', direction: 'LONG', action: 'EOD_SQUARE_OFF', entry: 1, exitPrice: 2, entryTimestampMs: 1, exitTimestampMs: 2 };
  await db.insertTradeEvent('real', 'darvasbox-shadow-0.25pct-1pctSL', cross, '2026-08-11');
  await db.insertTradeEvent('real', 'darvasbox-shadow-0.25pct-1pctSL', eod, '2026-08-11');

  // ON CONFLICT (tracker, symbol, direction, action, entry_ts, exit_ts) -- params[0,2,3,4,5,6].
  const conflictParams = (p) => [p[0], p[2], p[3], p[4], p[5], p[6]];
  assert.notDeepEqual(conflictParams(queries[0].params), conflictParams(queries[1].params));
});
