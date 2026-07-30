'use strict';

/**
 * Manual remediation for a real, recurring problem: server.js's daily
 * runOnce() only retries the Sales Growth fundamentals gate for
 * `fundamentalsPending` symbols WHEN Screener.in login succeeds THAT SAME
 * run (see server.js's `if (cookies) { ... }` retry block) -- if login
 * keeps failing on every subsequent daily run, a symbol just sits pending
 * forever, with no separate retry schedule of its own.
 *
 * Root-caused 2026-07-30: this is NOT the "occasional network blip" the
 * 2026-07-28 fetchWithRetry widening (3->6 attempts) was built for --
 * Screener.in responded 200 OK in 145ms from a non-Railway network at the
 * exact time Railway's own service logged "fetch failed" on all 6 widened
 * attempts. That's a Railway-egress-specific block/rate-limit against
 * Screener.in, not a transient connectivity issue -- more attempts or a
 * longer backoff from Railway will not fix it. Flagged as needing a real
 * fix (e.g. routing this specific fetch through a non-Railway egress) --
 * this script is the manual workaround in the meantime, safe to re-run
 * whenever the pending backlog needs clearing, from anywhere Screener.in
 * IS reachable.
 *
 * Deliberately narrower than server.js's runOnce(): does NOT re-run
 * fetchUniverse/computeTodayRanks/diffRsMomentum (expensive, and re-running
 * hours after the scheduled run would recompute today's RS ranks against
 * later intraday prices than the actual run used -- a real inconsistency
 * risk). Only retries the SAME fundamentalsPending gate server.js's own
 * retry block would have, using the identical alert copy and threshold, so
 * behavior is indistinguishable from Railway having resolved it on schedule.
 *
 * Usage: SCREENER_USERNAME=... SCREENER_PASSWORD=... GITHUB_TOKEN=...
 *        TELEGRAM_BOT_TOKEN=... node resolve_pending_fundamentals.js
 */

const fs = require('fs');
const path = require('path');
const { loginToScreener, fetchFundamentals } = require('./fundamental_screener');
const { syncFromRemote, commitAndPushTrackedState } = require('./git_state');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046'];
const SALES_GROWTH_MIN_PCT = 15; // matches server.js's own threshold exactly

const TRACKED_PATH = path.join(__dirname, 'tracked_rs_momentum.json');
const LOG_PATH = path.join(__dirname, 'rs_momentum_log.json');

async function sendTelegramAlert(text) {
  console.log('[ALERT]', text.replace(/\n/g, ' | '));
  if (!TELEGRAM_TOKEN) return;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) console.warn(`  Telegram send failed for chat ${chatId}: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`  Telegram send error for chat ${chatId}: ${e.message}`);
    }
  }
}

// Copied verbatim from server.js -- same alert copy for both outcomes.
function formatFundamentalsConfirmedAlert(symbol, fundamentals) {
  return [
    `[RS MOMENTUM] ${symbol}: fundamentals confirmed`,
    `Sales Growth 3Y: ${fundamentals.salesGrowth3Y}% (>=15% required) — gate cleared.`,
    'Position remains tracked, no action needed.',
  ].join('\n');
}
function formatFundamentalsFailedAlert(symbol, fundamentals) {
  return [
    `[RS MOMENTUM] ${symbol}: retracted — fundamentals gate failed`,
    `Sales Growth 3Y: ${fundamentals ? fundamentals.salesGrowth3Y + '%' : 'unavailable'} (>=15% required) — does not clear.`,
    'This was alerted earlier as fundamentals-pending; no longer tracked.',
  ].join('\n');
}

async function main() {
  console.log('Syncing latest state from GitHub...');
  await syncFromRemote();

  const tracked = fs.existsSync(TRACKED_PATH) ? JSON.parse(fs.readFileSync(TRACKED_PATH, 'utf8')) : {};
  const pendingSymbols = Object.keys(tracked).filter((s) => tracked[s].fundamentalsPending);
  console.log(`Pending symbols: ${pendingSymbols.length} (${pendingSymbols.join(', ') || 'none'})`);
  if (pendingSymbols.length === 0) {
    console.log('Nothing to resolve.');
    return;
  }

  const username = process.env.SCREENER_USERNAME;
  const password = process.env.SCREENER_PASSWORD;
  if (!username || !password) {
    console.error('SCREENER_USERNAME/SCREENER_PASSWORD not set -- cannot log in.');
    process.exit(1);
  }
  console.log('Logging into Screener.in...');
  const cookies = await loginToScreener(username, password);
  console.log('Login OK.');

  const logEntries = [];
  for (const symbol of pendingSymbols) {
    try {
      const fundamentals = await fetchFundamentals(symbol, cookies);
      if (fundamentals && fundamentals.salesGrowth3Y != null && fundamentals.salesGrowth3Y >= SALES_GROWTH_MIN_PCT) {
        tracked[symbol].salesGrowth3Y = fundamentals.salesGrowth3Y;
        delete tracked[symbol].fundamentalsPending;
        await sendTelegramAlert(formatFundamentalsConfirmedAlert(symbol, fundamentals));
        logEntries.push({ type: 'FUNDAMENTALS_CONFIRMED', symbol, salesGrowth3Y: fundamentals.salesGrowth3Y });
        console.log(`  ${symbol}: CONFIRMED (Sales Growth 3Y ${fundamentals.salesGrowth3Y}%)`);
      } else {
        await sendTelegramAlert(formatFundamentalsFailedAlert(symbol, fundamentals));
        logEntries.push({ type: 'FUNDAMENTALS_FAILED', symbol });
        delete tracked[symbol];
        console.log(`  ${symbol}: RETRACTED (Sales Growth 3Y ${fundamentals ? fundamentals.salesGrowth3Y : 'n/a'}%)`);
      }
    } catch (e) {
      console.warn(`  ${symbol}: fundamentals fetch failed (${e.message}) -- left pending, try again later.`);
    }
  }

  fs.writeFileSync(TRACKED_PATH, JSON.stringify(tracked, null, 1));
  let fullLog = fs.existsSync(LOG_PATH) ? JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')) : [];
  if (logEntries.length > 0) {
    fullLog = [...fullLog, ...logEntries];
    fs.writeFileSync(LOG_PATH, JSON.stringify(fullLog, null, 1));
  }

  const dateLabel = new Date().toISOString().slice(0, 10);
  const result = await commitAndPushTrackedState(dateLabel);
  console.log('Push result:', result);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
