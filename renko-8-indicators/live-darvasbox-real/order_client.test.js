'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderClient } = require('./order_client');

function mockFetchSequence(responses) {
  let i = 0;
  global.fetch = async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r;
  };
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

test.afterEach(() => { delete global.fetch; });

test('placeOrder: returns order_id on success', async () => {
  mockFetchSequence([jsonResponse(200, { data: { order_id: 'ORDER123' } })]);
  const client = new OrderClient(() => 'fake-token');
  const orderId = await client.placeOrder('NSE_EQ|INE111A01025', 10, 'BUY');
  assert.equal(orderId, 'ORDER123');
});

test('placeOrder: throws on non-2xx response', async () => {
  mockFetchSequence([jsonResponse(400, { status: 'error', errors: [{ message: 'insufficient margin' }] })]);
  const client = new OrderClient(() => 'fake-token');
  await assert.rejects(() => client.placeOrder('NSE_EQ|X', 10, 'BUY'), /HTTP 400/);
});

test('placeOrder: throws if response has no order_id', async () => {
  mockFetchSequence([jsonResponse(200, { data: {} })]);
  const client = new OrderClient(() => 'fake-token');
  await assert.rejects(() => client.placeOrder('NSE_EQ|X', 10, 'BUY'), /no order_id/);
});

test('waitForFill: returns immediately on a terminal "complete" status', async () => {
  mockFetchSequence([jsonResponse(200, { data: { status: 'complete', average_price: 108.5, filled_quantity: 10 } })]);
  const client = new OrderClient(() => 'fake-token');
  const fill = await client.waitForFill('ORDER123', { attempts: 3, delayMs: 1 });
  assert.equal(fill.status, 'complete');
  assert.equal(fill.avgPrice, 108.5);
  assert.equal(fill.filledQty, 10);
});

test('waitForFill: polls past a non-terminal "open" status until complete', async () => {
  mockFetchSequence([
    jsonResponse(200, { data: { status: 'open' } }),
    jsonResponse(200, { data: { status: 'open' } }),
    jsonResponse(200, { data: { status: 'complete', average_price: 99.1, filled_quantity: 5 } }),
  ]);
  const client = new OrderClient(() => 'fake-token');
  const fill = await client.waitForFill('ORDER123', { attempts: 5, delayMs: 1 });
  assert.equal(fill.status, 'complete');
  assert.equal(fill.avgPrice, 99.1);
});

test('waitForFill: returns "rejected" as a terminal status, not null', async () => {
  mockFetchSequence([jsonResponse(200, { data: { status: 'rejected' } })]);
  const client = new OrderClient(() => 'fake-token');
  const fill = await client.waitForFill('ORDER123', { attempts: 3, delayMs: 1 });
  assert.equal(fill.status, 'rejected');
});

test('waitForFill: returns null (not throw) if no terminal status is reached in the attempt budget', async () => {
  mockFetchSequence([jsonResponse(200, { data: { status: 'open' } })]);
  const client = new OrderClient(() => 'fake-token');
  const fill = await client.waitForFill('ORDER123', { attempts: 3, delayMs: 1 });
  assert.equal(fill, null);
});

test('getLtp: returns the price from the first successful ltp attempt', async () => {
  mockFetchSequence([jsonResponse(200, { data: { 'NSE_EQ:CONCOR': { last_price: 520.4 } } })]);
  const client = new OrderClient(() => 'fake-token');
  const ltp = await client.getLtp('NSE_EQ|INE111A01025');
  assert.equal(ltp, 520.4);
});

test('getLtp: falls back to /quotes if /ltp returns a data gap (0) twice', async () => {
  mockFetchSequence([
    jsonResponse(200, { data: { 'NSE_EQ:CONCOR': { last_price: 0 } } }),
    jsonResponse(200, { data: { 'NSE_EQ:CONCOR': { last_price: 0 } } }),
    jsonResponse(200, { data: { 'NSE_EQ:CONCOR': { last_price: 521.1 } } }),
  ]);
  const client = new OrderClient(() => 'fake-token');
  const ltp = await client.getLtp('NSE_EQ|INE111A01025');
  assert.equal(ltp, 521.1);
});

test('getLtp: returns null if all three attempts fail', async () => {
  mockFetchSequence([jsonResponse(500, {}), jsonResponse(500, {}), jsonResponse(500, {})]);
  const client = new OrderClient(() => 'fake-token');
  const ltp = await client.getLtp('NSE_EQ|INE111A01025');
  assert.equal(ltp, null);
});

test('getFunds: returns the equity segment data', async () => {
  mockFetchSequence([jsonResponse(200, { data: { equity: { available_margin: 50000, used_margin: 0 } } })]);
  const client = new OrderClient(() => 'fake-token');
  const funds = await client.getFunds();
  assert.equal(funds.available_margin, 50000);
});

test('getPositions: returns the positions array', async () => {
  mockFetchSequence([jsonResponse(200, { data: [{ instrument_token: 'NSE_EQ|X', quantity: 10 }] })]);
  const client = new OrderClient(() => 'fake-token');
  const positions = await client.getPositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].quantity, 10);
});
