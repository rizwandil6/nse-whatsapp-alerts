'use strict';

/**
 * Persistent trade log for the DarvasBox paper-alert poller, pushed to a
 * dedicated GitHub branch (never `main`) after every completed trade.
 * Same pattern just applied to the ORB live streamer earlier today, for
 * the same reason: any push to `main` redeploys every Railway service in
 * this repo, so a strategy's own trade-log commits must never land there
 * or they risk killing themselves (or something else) mid-session. This
 * is shared infrastructure logic (git-branch persistence), not DarvasBox
 * strategy code, so reusing the pattern here is a fresh, independent
 * implementation of the same fix -- not an import from the ORB service.
 */

const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'rizwandil6';
const REPO_NAME = 'nse-whatsapp-alerts';
const REPO_REL_PATH = 'renko-8-indicators/live/darvasbox_paper_trade_log.json';
const DATA_BRANCH = 'data/darvasbox-paper-trade-log';
const SOURCE_BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';
const LOCAL_PATH = path.join(__dirname, 'darvasbox_paper_trade_log.json');

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'darvasbox-live-poller',
  };
}

async function getRemoteFile(token, branch) {
  const url = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${REPO_REL_PATH}?ref=${branch}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET trade log failed: HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  return { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha };
}

async function ensureDataBranchExists(token) {
  const refUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${DATA_BRANCH}`;
  const existing = await fetch(refUrl, { headers: authHeaders(token) });
  if (existing.status === 200) return;
  if (existing.status !== 404) throw new Error(`Checking ${DATA_BRANCH} failed: HTTP ${existing.status}`);

  const sourceRefUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${SOURCE_BRANCH}`;
  const sourceRes = await fetch(sourceRefUrl, { headers: authHeaders(token) });
  if (!sourceRes.ok) throw new Error(`Reading ${SOURCE_BRANCH} ref failed: HTTP ${sourceRes.status}`);
  const sourceRef = await sourceRes.json();

  const createRes = await fetch(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${DATA_BRANCH}`, sha: sourceRef.object.sha }),
  });
  if (!createRes.ok) throw new Error(`Creating ${DATA_BRANCH} failed: HTTP ${createRes.status} — ${await createRes.text()}`);
  console.log(`Created ${DATA_BRANCH} branch.`);
}

async function syncFromRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.warn('GITHUB_TOKEN not set — trade log local-only.'); return; }
  try {
    let remote = await getRemoteFile(token, DATA_BRANCH).catch(() => null);
    if (remote) fs.writeFileSync(LOCAL_PATH, remote.content);
    console.log(`Synced DarvasBox paper trade log from GitHub (${DATA_BRANCH}).`);
  } catch (e) {
    console.error('Trade log sync failed, proceeding with on-disk log as-is:', e.message);
  }
}

function recordTrade(exitEvent) {
  const log = fs.existsSync(LOCAL_PATH) ? JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8')) : [];
  log.push(exitEvent);
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(log, null, 1));
}

async function pushToGitHub(dateLabel) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { pushed: false, reason: 'no_token' };
  if (!fs.existsSync(LOCAL_PATH)) return { pushed: false, reason: 'no_file' };
  try {
    await ensureDataBranchExists(token);
    const localContent = fs.readFileSync(LOCAL_PATH, 'utf8');
    const remote = await getRemoteFile(token, DATA_BRANCH);
    if (remote && remote.content === localContent) return { pushed: false, reason: 'no_changes' };
    const res = await fetch(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${REPO_REL_PATH}`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `DarvasBox paper trade log update (${dateLabel})`,
        content: Buffer.from(localContent, 'utf8').toString('base64'),
        branch: DATA_BRANCH,
        ...(remote ? { sha: remote.sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`PUT failed: HTTP ${res.status} — ${await res.text()}`);
    console.log(`Pushed DarvasBox paper trade log to GitHub (${DATA_BRANCH}).`);
    return { pushed: true };
  } catch (e) {
    console.error('Trade log push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

async function recordAndPush(exitEvent, dateLabel) {
  recordTrade(exitEvent);
  return pushToGitHub(dateLabel).catch((e) => console.error('recordAndPush threw:', e.message));
}

module.exports = { syncFromRemote, recordAndPush };
