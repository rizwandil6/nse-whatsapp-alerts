'use strict';

/**
 * Persists screener state to GitHub via the REST API (plain fetch, no
 * `git` binary — see the comment history in this file's earlier version
 * for why: Railway's Node buildpack runtime doesn't ship git, so a
 * git-shell-out approach could never work here). Requires a GITHUB_TOKEN
 * env var (a fine-grained PAT, Contents: Read and write, scoped to this
 * one repo).
 *
 * commitAndPushTrackedState bundles every changed state file into ONE
 * commit via the Git Data API (blob -> tree -> commit -> ref update),
 * not one Contents-API PUT per file. Each push to `main` redeploys every
 * Railway service in this repo (including reactivating any explicitly
 * paused ones, e.g. ema-scalp-live-streamer) — four separate commits per
 * run meant four separate redeploy cycles for no reason. One commit per
 * run, regardless of how many of the four state files actually changed.
 *
 * Pushed to a DEDICATED DATA BRANCH (see BRANCH below), never `main` --
 * one commit per run was still landing on `main` and redeploying every
 * other Railway service daily for no reason related to any of them; fixed
 * 2026-07-23 using the same dedicated-branch pattern already applied to
 * orb-live-streamer and darvasbox-live's trade logs.
 */

const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'rizwandil6';
const REPO_NAME = 'nse-whatsapp-alerts';
const BRANCH = 'data/multibagger-log'; // dedicated, non-deploy-triggering branch
const SOURCE_BRANCH = 'main'; // only used to seed BRANCH if it doesn't exist yet
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

/** Thin wrapper: JSON in, JSON out, throws with response body on non-2xx. */
async function ghApi(url, token, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...authHeaders(token), ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${url} failed: HTTP ${res.status} — ${await res.text()}`);
  return res.status === 204 ? null : res.json();
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

/** Creates BRANCH pointing at SOURCE_BRANCH's current HEAD, if it doesn't already exist. Idempotent. */
async function ensureDataBranchExists(token) {
  const refUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${BRANCH}`;
  const existing = await fetch(refUrl, { headers: authHeaders(token) });
  if (existing.status === 200) return;
  if (existing.status !== 404) {
    throw new Error(`Checking ${BRANCH} failed: HTTP ${existing.status} — ${await existing.text()}`);
  }

  const sourceRefUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${SOURCE_BRANCH}`;
  const sourceRes = await fetch(sourceRefUrl, { headers: authHeaders(token) });
  if (!sourceRes.ok) throw new Error(`Reading ${SOURCE_BRANCH} ref failed: HTTP ${sourceRes.status} — ${await sourceRes.text()}`);
  const sourceRef = await sourceRes.json();

  const createUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`;
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: sourceRef.object.sha }),
  });
  if (!createRes.ok) throw new Error(`Creating ${BRANCH} failed: HTTP ${createRes.status} — ${await createRes.text()}`);
  console.log(`Created ${BRANCH} branch (seeded from ${SOURCE_BRANCH}).`);
}

/**
 * Pulls the latest version of every state file down from GitHub to local
 * disk, before this run reads any of them — same reasoning as the old git
 * version: without this, a run would work off whatever was baked into the
 * container at build time instead of what previous runs actually wrote. A
 * state file that doesn't exist on GitHub yet (first run ever) is left
 * alone locally rather than treated as an error.
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

/**
 * Pushes every state file that actually changed up to GitHub as ONE
 * commit (blob per changed file -> one new tree on top of main's current
 * tree -> one commit -> fast-forward the main ref) — not one commit per
 * file. No-ops (no commit at all) if nothing changed.
 */
async function commitAndPushTrackedState(dateLabel) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN not set — skipping state push. State was written locally only and will NOT survive a restart.');
    return { pushed: false, reason: 'no_token' };
  }

  try {
    const changed = [];
    for (const { rel, local } of STATE_FILES) {
      if (!fs.existsSync(local)) continue;
      const localContent = fs.readFileSync(local, 'utf8');
      const remote = await getRemoteFile(rel, token);
      if (remote && remote.content === localContent) continue;
      changed.push({ rel, content: localContent });
    }
    if (changed.length === 0) {
      console.log('No state changes — nothing to commit.');
      return { pushed: false, reason: 'no_changes' };
    }

    await ensureDataBranchExists(token);

    const refUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/refs/heads/${BRANCH}`;
    const ref = await ghApi(refUrl, token);
    const baseCommitSha = ref.object.sha;
    const baseCommit = await ghApi(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/commits/${baseCommitSha}`, token);

    const treeEntries = [];
    for (const { rel, content } of changed) {
      const blob = await ghApi(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/blobs`, token, {
        method: 'POST',
        body: JSON.stringify({ content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' }),
      });
      treeEntries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const newTree = await ghApi(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/trees`, token, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeEntries }),
    });

    const newCommit = await ghApi(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/commits`, token, {
      method: 'POST',
      body: JSON.stringify({
        message: `Multibagger screen daily batch update (${dateLabel})`,
        tree: newTree.sha,
        parents: [baseCommitSha],
      }),
    });

    await ghApi(refUrl, token, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha }) });

    console.log(`Pushed updated state to GitHub in one commit (${changed.length} file(s): ${changed.map((c) => c.rel.split('/').pop()).join(', ')}).`);
    return { pushed: true, filesChanged: changed.map((c) => c.rel) };
  } catch (e) {
    console.error('GitHub push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

module.exports = { commitAndPushTrackedState, syncFromRemote };
