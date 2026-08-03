'use strict';

/**
 * Shared, per-branch push serialization across every module in this
 * service that writes to GitHub content branches.
 *
 * Real incident, 2026-08-03: trade_log.js and tracked_state.js
 * intentionally share one data branch (data/darvasbox-shadow-0.25pct-1pctSL-trade-log),
 * and variant_log.js + variant_tracked_state.js share another
 * (data/darvasbox-variant-antichase-eodstop) -- but each file only kept
 * its OWN local `pushChain` promise, which serializes a file's writes
 * against itself but does nothing to stop it from racing against the
 * OTHER file sharing its branch. Confirmed live: tracked_state.js's
 * frequent commits kept landing between trade_log.js's SHA read and its
 * PUT, so trade_log.js's push -- the dashboard's actual data source --
 * was losing that race and failing with HTTP 409 on almost every attempt,
 * with no retry. One queue per branch name, shared by every writer to
 * that branch, fixes this at the root instead of in just one file.
 */

const chains = new Map();

/** Runs `taskFn` after every previously queued push to the same `branch`
 * has settled (success or failure) -- never rejects the shared chain
 * itself, so one failed push doesn't wedge the queue for the next one. */
function serialize(branch, taskFn) {
  const prev = chains.get(branch) || Promise.resolve();
  const settled = prev.catch(() => {});
  const next = settled.then(taskFn);
  chains.set(branch, next.catch(() => {}));
  return next;
}

module.exports = { serialize };
