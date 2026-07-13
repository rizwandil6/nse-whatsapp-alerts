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
const TRACKED_FILE_REL = 'multibagger-screener/tracked_multibaggers.json';

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO_DIR, stdio: 'pipe', ...opts }).toString();
}

function commitAndPushTrackedState(monthLabel) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN not set — skipping git commit/push. Tracked state was written locally only and will NOT survive a restart.');
    return { pushed: false, reason: 'no_token' };
  }

  try {
    run('git config user.email "multibagger-screener@railway"');
    run('git config user.name "Multibagger Screener (automated)"');
    run(`git add ${TRACKED_FILE_REL}`);

    const status = run('git status --porcelain');
    if (!status.trim()) {
      console.log('No changes to tracked_multibaggers.json — nothing to commit.');
      return { pushed: false, reason: 'no_changes' };
    }

    run(`git commit -m "Monthly multibagger screen update (${monthLabel})"`);

    const remoteUrl = run('git config --get remote.origin.url').trim();
    const authedUrl = remoteUrl.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
    run(`git push ${authedUrl} HEAD:main`);
    console.log('Pushed updated tracked_multibaggers.json.');
    return { pushed: true };
  } catch (e) {
    console.error('git commit/push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

module.exports = { commitAndPushTrackedState };
