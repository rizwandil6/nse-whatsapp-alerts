'use strict';

/**
 * Persists screener state to GitHub via the REST Contents API (plain
 * fetch, no `git` binary) — the only durable persistence option available,
 * since Railway's Trial plan has no persistent volumes and this state must
 * survive indefinitely between runs. Requires a GITHUB_TOKEN env var (a
 * fine-grained PAT, Contents: Read and write, scoped to this one repo).
 *
 * REWRITTEN from a git-shell-out version after production logs showed
 * "/bin/sh: 1: git: not found" — Railway's Node buildpack (Railpack)
 * runtime image doesn't ship the git binary, so `execSync('git ...')`
 * could never work here no matter how correct the git logic was. This
 * never surfaced in local testing since the dev machine has git installed.
 * The REST API has no such dependency: every read/write is a plain HTTPS
 * call, so it works identically local vs. deployed.
 */

const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'rizwandil6';
const REPO_NAME = 'nse-whatsapp-alerts';
const BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';

const STATE_FILES = [
  { rel: 'multibagger-screener/tracked_multibaggers.json', local: path.join(__dirname, 'tracked_multibaggers.json') },
  { rel: 'multibagger-screener/all_results.json', local: path.join(__dirname, 'all_results.json') },
  { rel: 'multibagger-screener/scan_cursor.json', local: path.join(__dirname, 'scan_cursor.json') },
  { rel: 'multibagger-screener/forward_performance_log.json', local: path.join(__dirname, 'forward_performance_log.json') },
];

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'multibagger-screener',
  };
}

/** Fetches one file's content+sha from the repo, or null if it doesn't exist yet on GitHub. */
async function getRemoteFile(relPath, token) {
  const url = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${relPath}?ref=${BRANCH}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${relPath} failed: HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  return { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha };
}

/**
 * Pulls the latest version of every state file down from GitHub to local
 * disk, before this run reads any of them — must happen first, same reason
 * as the old git version: without this, a run would work off whatever was
 * baked into the container at build time instead of what previous runs
 * actually wrote. A state file that doesn't exist on GitHub yet (first run
 * ever) is left alone locally rather than treated as an error.
 */
async function syncFromRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN not set — cannot sync from remote. Using whatever state files are on disk (may be stale or absent).');
    return { synced: false, reason: 'no_token' };
  }
  try {
    for (const { rel, local } of STATE_FILES) {
      const remote = await getRemoteFile(rel, token);
      if (remote) fs.writeFileSync(local, remote.content);
    }
    console.log('Synced local state from GitHub.');
    return { synced: true };
  } catch (e) {
    console.error('GitHub sync failed — proceeding with on-disk state as-is:', e.message);
    return { synced: false, reason: 'error', error: e.message };
  }
}

/** Pushes every state file that exists locally and has actually changed up to GitHub, one commit per file. */
async function commitAndPushTrackedState(dateLabel) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN not set — skipping state push. State was written locally only and will NOT survive a restart.');
    return { pushed: false, reason: 'no_token' };
  }

  let pushedAny = false;
  try {
    for (const { rel, local } of STATE_FILES) {
      if (!fs.existsSync(local)) continue;
      const localContent = fs.readFileSync(local, 'utf8');
      const remote = await getRemoteFile(rel, token);
      if (remote && remote.content === localContent) continue; // unchanged, skip

      const res = await fetch(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${rel}`, {
        method: 'PUT',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Multibagger screen daily batch update (${dateLabel})`,
          content: Buffer.from(localContent, 'utf8').toString('base64'),
          branch: BRANCH,
          ...(remote ? { sha: remote.sha } : {}),
        }),
      });
      if (!res.ok) throw new Error(`PUT ${rel} failed: HTTP ${res.status} — ${await res.text()}`);
      pushedAny = true;
    }
    if (pushedAny) console.log('Pushed updated state files to GitHub.');
    else console.log('No state changes — nothing to push.');
    return { pushed: pushedAny };
  } catch (e) {
    console.error('GitHub push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

module.exports = { commitAndPushTrackedState, syncFromRemote };
