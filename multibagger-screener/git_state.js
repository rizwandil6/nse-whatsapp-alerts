'use strict';

/**
 * Commits the updated tracked-stocks list back to the GitHub repo — the
 * only durable persistence option available, since Railway's Trial plan
 * has no persistent volumes and this state must survive a full month
 * between runs. Requires a GITHUB_TOKEN env var (a Personal Access Token
 * with repo write access) — set up as its own explicit step, since
 * granting a deployed container push access to the repo is a real
 * decision, not just a technical detail.
 */

const { execSync } = require('child_process');
const path = require('path');

const REPO_DIR = path.join(__dirname, '..'); // git root is the parent of multibagger-screener/
const STATE_FILES_REL = [
  'multibagger-screener/tracked_multibaggers.json',
  'multibagger-screener/all_results.json',
  'multibagger-screener/scan_cursor.json',
  'multibagger-screener/forward_performance_log.json',
];

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO_DIR, stdio: 'pipe', ...opts }).toString();
}

function authedRemoteUrl(token) {
  const remoteUrl = run('git config --get remote.origin.url').trim();
  return remoteUrl.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
}

/**
 * Syncs the container's local checkout to the latest origin/main BEFORE
 * this run reads any state files from disk. Required because the
 * container's git checkout is a build-time snapshot — without this, day 2
 * onward would push on top of an increasingly stale local HEAD and get
 * rejected as non-fast-forward the moment origin/main has moved (which it
 * will, from THIS SAME script's own successful pushes on previous days).
 * Safe to hard-reset: the only local modifications that ever exist are the
 * three state files this script itself writes, which is exactly what
 * should be discarded in favor of the latest remote state before re-reading.
 */
function syncFromRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN not set — cannot sync from remote. Using whatever state files are on disk (may be stale or absent).');
    return { synced: false, reason: 'no_token' };
  }
  try {
    run(`git fetch ${authedRemoteUrl(token)} main`);
    run('git reset --hard FETCH_HEAD');
    console.log('Synced local state to latest origin/main.');
    return { synced: true };
  } catch (e) {
    console.error('git fetch/reset failed — proceeding with on-disk state as-is:', e.message);
    return { synced: false, reason: 'error', error: e.message };
  }
}

function commitAndPushTrackedState(dateLabel) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN not set — skipping git commit/push. State was written locally only and will NOT survive a restart.');
    return { pushed: false, reason: 'no_token' };
  }

  try {
    run('git config user.email "multibagger-screener@railway"');
    run('git config user.name "Multibagger Screener (automated)"');
    run(`git add ${STATE_FILES_REL.join(' ')}`);

    const status = run('git status --porcelain');
    if (!status.trim()) {
      console.log('No state changes — nothing to commit.');
      return { pushed: false, reason: 'no_changes' };
    }

    run(`git commit -m "Multibagger screen daily batch update (${dateLabel})"`);
    run(`git push ${authedRemoteUrl(token)} HEAD:main`);
    console.log('Pushed updated state files.');
    return { pushed: true };
  } catch (e) {
    console.error('git commit/push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

module.exports = { commitAndPushTrackedState, syncFromRemote };
