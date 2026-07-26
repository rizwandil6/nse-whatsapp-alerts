'use strict';

/**
 * Small shared GitHub Contents API helper used by both trade_log.js and
 * state_store.js -- they persist different files to different dedicated
 * branches, but need the identical get/ensure-branch/put plumbing. Kept
 * as an internal module WITHIN this self-contained live/ directory (not a
 * cross-directory require, so it doesn't run into Railway's Root
 * Directory build-scoping issue that rules out sharing code with
 * renko-8-indicators/live/).
 */

const REPO_OWNER = 'rizwandil6';
const REPO_NAME = 'nse-whatsapp-alerts';
const SOURCE_BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'renko-combo-live-forward-test',
  };
}

async function getRemoteFile(token, repoRelPath, branch) {
  const url = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${repoRelPath}?ref=${branch}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${repoRelPath}@${branch} failed: HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  return { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha };
}

/** Creates `branch` off `main` if it doesn't already exist. Never touches `main` itself. */
async function ensureBranchExists(token, branch) {
  const refUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${branch}`;
  const existing = await fetch(refUrl, { headers: authHeaders(token) });
  if (existing.status === 200) return;
  if (existing.status !== 404) throw new Error(`Checking ${branch} failed: HTTP ${existing.status}`);

  const sourceRefUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${SOURCE_BRANCH}`;
  const sourceRes = await fetch(sourceRefUrl, { headers: authHeaders(token) });
  if (!sourceRes.ok) throw new Error(`Reading ${SOURCE_BRANCH} ref failed: HTTP ${sourceRes.status}`);
  const sourceRef = await sourceRes.json();

  const createRes = await fetch(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: sourceRef.object.sha }),
  });
  if (!createRes.ok) throw new Error(`Creating ${branch} failed: HTTP ${createRes.status} — ${await createRes.text()}`);
  console.log(`Created ${branch} branch.`);
}

async function putFile(token, repoRelPath, branch, content, message, sha) {
  const res = await fetch(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${repoRelPath}`, {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`PUT ${repoRelPath}@${branch} failed: HTTP ${res.status} — ${await res.text()}`);
}

module.exports = { getRemoteFile, ensureBranchExists, putFile, REPO_OWNER, REPO_NAME };
