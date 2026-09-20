'use strict';

/**
 * Minimal Telegram sender, same chat IDs / pattern as the other live bots in
 * this repo. Alert-only by design (2026-09-20 decision, see README) -- this
 * service never places or modifies any order; it only ever notifies.
 */

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046']; // personal + group (same as other bots)

async function sendTelegram(text) {
  console.log('[TRIPLE RSI ALERT]', text.replace(/\n/g, ' | '));
  if (!TELEGRAM_TOKEN) { console.warn('  TELEGRAM_BOT_TOKEN not set — alert logged, not sent.'); return false; }
  let allOk = true;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) { allOk = false; console.warn(`  Telegram send failed for ${chatId}: HTTP ${res.status}`); }
    } catch (e) { allOk = false; console.warn(`  Telegram send error for ${chatId}: ${e.message}`); }
  }
  return allOk;
}

module.exports = { sendTelegram };
