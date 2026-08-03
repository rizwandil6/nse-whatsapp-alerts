'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serialize } = require('./github_push_queue');

// Real incident, 2026-08-03: trade_log.js and tracked_state.js share one GitHub
// data branch, each with its OWN local pushChain -- which serializes a file's
// writes against itself but does nothing to stop it racing against the OTHER
// file sharing its branch, producing HTTP 409s on almost every trade_log push.
// These tests exercise the cross-caller serialization directly (no GitHub I/O).

test('serialize: two calls on the SAME branch never overlap in time', async () => {
  const branch = 'branch-a';
  const events = [];
  let active = 0;

  const task = (label) => async () => {
    active++;
    events.push(`${label}-start`);
    assert.equal(active, 1, `${label} started while another task on the same branch was still running`);
    await new Promise((r) => setTimeout(r, 10));
    events.push(`${label}-end`);
    active--;
  };

  // Fired "concurrently" (no await between them), simulating trade_log.js's push
  // and tracked_state.js's push both firing off an event handler in the same tick.
  const p1 = serialize(branch, task('A'));
  const p2 = serialize(branch, task('B'));
  await Promise.all([p1, p2]);

  assert.deepEqual(events, ['A-start', 'A-end', 'B-start', 'B-end']);
});

test('serialize: calls on DIFFERENT branches run independently (not needlessly serialized)', async () => {
  const order = [];
  const slow = async () => {
    order.push('slow-start');
    await new Promise((r) => setTimeout(r, 20));
    order.push('slow-end');
  };
  const fast = async () => {
    order.push('fast-start');
    order.push('fast-end');
  };

  const p1 = serialize('branch-slow', slow);
  const p2 = serialize('branch-fast', fast);
  await Promise.all([p1, p2]);

  // fast (different branch) finishes well before slow, proving the two branches
  // aren't sharing one global queue.
  assert.deepEqual(order, ['slow-start', 'fast-start', 'fast-end', 'slow-end']);
});

test('serialize: a rejected task does not wedge the queue for the next caller on the same branch', async () => {
  const branch = 'branch-b';
  const first = serialize(branch, async () => {
    throw new Error('boom');
  });
  // The caller of the failing push still sees its own rejection...
  await assert.rejects(first, /boom/);

  // ...but the NEXT push on the same branch (e.g. tracked_state.js's, right after
  // trade_log.js's push failed) must still run, not hang forever.
  const second = serialize(branch, async () => 'ok');
  assert.equal(await second, 'ok');
});
