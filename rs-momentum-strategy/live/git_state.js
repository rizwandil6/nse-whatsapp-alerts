'use strict';

/**
 * Persists RS-momentum state to GitHub via the REST API (plain fetch, no
 * `git` binary -- Railway's Node buildpack runtime doesn't ship it, a real
 * bug found and fixed the hard way in multibagger-screener/git_state.js;
 * this service is built with that lesson already applied, not repeating
 * the mistake). Bundles every changed state file into ONE commit per run
 * (Git Data API: blob -> tree -> commit -> ref update) -- every push to
 * `main` redeploys every Railway service in this repo, so one commit per
 * run matters here too, same reasoning as multibagger-screener's own fix.
 */

const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'rizwandil6';
const REPO_NAME = 'nse-whatsapp-alerts';
const BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';

const STATE_FILES = [
  { rel: 'rs-momentum-strategy/live/tracked_rs_momentum.json', local: path.join(__dirname, 'tracked_rs_momentum.json') },
  { rel: 'rs-momentum-strategy/live/rs_momentum_log.json', local: path.join(__dirname, 'rs_momentum_log.json') },
];

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rs-momentum-strategy',
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
  const url = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${relPath}?ref=${BRANCH}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${relPath} failed: HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  return { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha };
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
        message: `RS momentum strategy daily update (${dateLabel})`,
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
