'use strict';

/**
 * Persists this strategy's state to GitHub via the REST API (plain fetch,
 * no `git` binary -- Railway's Node buildpack runtime doesn't ship it, a
 * real bug found and fixed the hard way in multibagger-screener/git_state.js).
 * Bundles every changed state file into ONE commit per run (Git Data API:
 * blob -> tree -> commit -> ref update), same reasoning as
 * rs-momentum-strategy/live/git_state.js -- every push to `main` redeploys
 * every Railway service in this repo, so this pushes to a DEDICATED DATA
 * BRANCH (never `main`), and bundles both state files together rather than
 * two separate single-file pushes.
 *
 * TWO state files, unlike DarvasBox's trade-log-only persistence, because
 * positions here can span multiple days (no daily reset, no forced EOD
 * square-off -- see williams_r_tracker.js's module docstring): the trade
 * log alone isn't enough to resume correctly after a restart, the CURRENT
 * open position + watch-state per symbol must also survive.
 *
 * getRemoteFile includes the >1MB Contents-API-doesn't-inline-content
 * fallback (raw.githubusercontent.com) -- confirmed production bug
 * 2026-07-27 in renko-python-backtest/live/, fixed there and in
 * darvasbox-shadow/github_contents.js; built in here from day one rather
 * than repeating it a third time.
 */

const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'rizwandil6';
const REPO_NAME = 'nse-whatsapp-alerts';
const BRANCH = 'data/williams-r-strategy-live'; // dedicated, non-deploy-triggering branch
const SOURCE_BRANCH = 'main'; // only used to seed BRANCH if it doesn't exist yet
const GITHUB_API = 'https://api.github.com';

const STATE_FILES = [
  { rel: 'williams-r-strategy/live/tracked_williams_r.json', local: path.join(__dirname, 'tracked_williams_r.json') },
  { rel: 'williams-r-strategy/live/williams_r_trade_log.json', local: path.join(__dirname, 'williams_r_trade_log.json') },
];

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'williams-r-strategy-live',
  };
}

async function ghApi(url, token, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...authHeaders(token), ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${url} failed: HTTP ${res.status} — ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function getRemoteFile(relPath, token) {
  const metaUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${relPath}?ref=${BRANCH}`;
  const metaRes = await fetch(metaUrl, { headers: authHeaders(token) });
  if (metaRes.status === 404) return null;
  if (!metaRes.ok) throw new Error(`GET ${relPath} failed: HTTP ${metaRes.status} — ${await metaRes.text()}`);
  const meta = await metaRes.json();

  let content;
  if (meta.encoding === 'base64' && meta.content) {
    content = Buffer.from(meta.content, 'base64').toString('utf8');
  } else {
    const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/${relPath}`;
    const rawRes = await fetch(rawUrl, { headers: { 'User-Agent': 'williams-r-strategy-live' } });
    if (!rawRes.ok) throw new Error(`GET raw ${relPath} failed: HTTP ${rawRes.status}`);
    content = await rawRes.text();
  }
  return { content, sha: meta.sha };
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
  if (createRes.status === 422) return; // concurrent creation -- fine, branch exists either way
  if (!createRes.ok) throw new Error(`Creating ${BRANCH} failed: HTTP ${createRes.status} — ${await createRes.text()}`);
  console.log(`Created ${BRANCH} branch (seeded from ${SOURCE_BRANCH}).`);
}

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

async function commitAndPushState(dateLabel) {
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
        message: `Williams %R strategy state update (${dateLabel})`,
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

module.exports = { syncFromRemote, commitAndPushState, STATE_FILES, BRANCH };
