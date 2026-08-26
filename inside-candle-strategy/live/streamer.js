'use strict';

/**
 * Live Inside Candle Sweep+Break scanner for BTCINR and XAUINR on Pi42.
 *
 * Data source: Pi42's PUBLIC market data only, same pattern as
 * ichimoku-btc-xau-strategy/live/streamer.js:
 *   - History seed: POST /v1/market/klines (REST, unauthenticated) -- pi42_client.js.
 *   - Live bars: the public Socket.IO WebSocket at https://fawss.pi42.com/,
 *     subscribed to `{symbol}@kline_15m` and `{symbol}@kline_1m`.
 *
 * Strategy: wiki/concepts/inside-candle-liquidity-sweep-scalp.md +
 * wiki/reference/inside-candle-next-candle-sweep-break.pine (the validated
 * Pine version this is a direct port of). Engine: ic_engine.js.
 *
 * Alert-only. NO orders are ever placed -- this file makes zero authenticated
 * Pi42 requests, same boundary as every sibling strategy in this repo.
 *
 * Requires: TELEGRAM_BOT_TOKEN and DATABASE_URL (or .secrets/pg_url.txt) to
 * get alerts/persistence; runs (streams + logs to console) without either.
 */

const { io } = require('socket.io-client');

const { IcSymbolTracker, R_TARGET } = require('./ic_engine');
const { fetchKlines } = require('./pi42_client');
const { DB } = require('./db');
const { pnlPct } = require('./stats');

// Same symbol set as ichimoku-btc-xau-strategy (INR-margined, per the user's explicit request
// there -- see that strategy's README "Symbol-set switch: BTCUSDT/XAUUSDT -> BTCINR/XAUINR").
const ENTRY_SYMBOLS = ['BTCINR', 'XAUINR'];
const WS_URL = 'https://fawss.pi42.com/';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046']; // personal + group, same as every sibling bot

const SEED_M15 = 100; // enough history for the inside-candle check plus some dashboard-worthy context
const MAX_BARS_KEPT = 2000; // memory cap for a long-running process

if (!TELEGRAM_TOKEN) console.warn('WARNING: TELEGRAM_BOT_TOKEN not set. Alerts logged, not sent.');

const db = new DB();
const trackers = {}; // symbol -> IcSymbolTracker
const signalIds = {}; // symbol -> latest Postgres signals.id
// Per-symbol, per-timeframe "currently forming" bar, keyed by its startTime (ms) -- same
// rollover-detection idiom as ichimoku-btc-xau-strategy/live/streamer.js.
const forming = {}; // `${symbol}:${tf}` -> { timestampMs, open, high, low, close, volume }

function fmtPx(x) { return x == null ? '—' : Number(x).toFixed(2); }
function istLikeUtc(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }

// ---- Telegram -----------------------------------------------------------
async function sendTelegram(text) {
  console.log('[ALERT]', text.replace(/\n/g, ' | '));
  if (!TELEGRAM_TOKEN) return false;
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

function fmtSetup(e) {
  return [
    `${e.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} INSIDE CANDLE SWEEP+BREAK — ${e.symbol}`,
    `IC high ${fmtPx(e.icHigh)}  |  IC low ${fmtPx(e.icLow)}`,
    `Entry ${fmtPx(e.entryPx)}  |  Stop ${fmtPx(e.stop)}  |  R ${fmtPx(e.r)}`,
    `Target (${R_TARGET}R) ${fmtPx(e.target)}`,
    `${istLikeUtc(e.entryTs)} · alert-only, no order placed.`,
  ].join('\n');
}
// stats = { count, winRate, cumPnlPct } from db.getStats() -- prepended so every outcome alert
// carries the strategy's live track record, not just this one trade's result. AFTER this trade
// is included (see handleEvents: db.closeOutcome runs before db.getStats() is called).
function fmtOutcome(e, stats) {
  const icon = e.result === 'TARGET' ? '✅' : '🛑';
  const pct = pnlPct(e.direction, e.entryPx, e.exitPx);
  const lines = [];
  if (stats && stats.count > 0) {
    lines.push(`📊 Inside Candle so far: ${stats.winRate}% win rate (${stats.count} trades) · cum P&L ${stats.cumPnlPct >= 0 ? '+' : ''}${stats.cumPnlPct}%`);
  }
  lines.push(
    `${icon} ${e.symbol} closed — ${e.result} @ ${fmtPx(e.exitPx)}`,
    `P&L: ${pct != null ? `${pct >= 0 ? '+' : ''}${pct}%` : '—'}  |  R-multiple: ${e.rMultiple >= 0 ? '+' : ''}${Number(e.rMultiple).toFixed(2)}R`,
    `${istLikeUtc(e.closedTs)}.`,
  );
  return lines.join('\n');
}

// Console-only (no Telegram, no DB) -- one line per closed 15m bar, so `railway logs` can
// confirm the bot is actually receiving/processing live data, not just sitting connected.
function fmtDiagnostic(e) {
  const when = istLikeUtc(e.ts);
  const state = e.openTrade ? 'in-trade' : e.nowPending ? `PENDING (IC ${fmtPx(e.icLow)}-${fmtPx(e.icHigh)})` : e.wasPendingUnresolved ? 'window closed unresolved' : 'watching';
  return `[check] ${e.symbol} ${when} close=${fmtPx(e.close)} | inside=${e.isInside} | ${state}`;
}

async function emit(alertType, symbol, text, signalId) {
  const ok = await sendTelegram(text);
  await db.insertAlert({ signalId, symbol, alertType, chatId: TELEGRAM_CHAT_IDS.join(','), text, sentOk: ok });
}

async function handleEvents(events) {
  for (const e of events) {
    if (e.type === 'SETUP') {
      const id = await db.insertSignal(e);
      if (id != null) signalIds[e.symbol] = id;
      await emit('SETUP', e.symbol, fmtSetup(e), signalIds[e.symbol]);
    } else if (e.type === 'OUTCOME') {
      await db.closeOutcome(signalIds[e.symbol], e);
      const stats = await db.getStats(); // AFTER closeOutcome so this trade counts in the stats
      await emit(e.result, e.symbol, fmtOutcome(e, stats), signalIds[e.symbol]);
    } else if (e.type === 'DIAGNOSTIC') {
      console.log(fmtDiagnostic(e)); // server logs only -- no Telegram, no DB insert
    }
  }
}

// Serialize event handling per symbol so a signal's INSERT always completes before its OUTCOME UPDATE.
const chains = {};
function enqueue(symbol, events) {
  if (!events || events.length === 0) return;
  chains[symbol] = (chains[symbol] || Promise.resolve())
    .then(() => handleEvents(events))
    .catch((e) => console.error(`handleEvents error [${symbol}]:`, e.message));
}

// ---- history seeding ------------------------------------------------------
async function seedSymbol(symbol) {
  const tracker = new IcSymbolTracker(symbol, { entriesEnabled: ENTRY_SYMBOLS.includes(symbol) });
  const m15 = await fetchKlines(symbol, '15m', SEED_M15);
  tracker.seedHistory(m15);
  trackers[symbol] = tracker;
  if (m15.length) forming[`${symbol}:m15`] = { ...m15[m15.length - 1] };
  console.log(`[seed] ${symbol}: 15m=${m15.length} bars`);

  // Resume any still-OPEN position from a prior process run (same restart-resilience pattern
  // as ichimoku-btc-xau-strategy -- see that strategy's README for the incident that motivated it).
  const openRow = await db.getOpenSignal(symbol);
  if (openRow) {
    signalIds[symbol] = Number(openRow.id);
    await db.abandonOtherOpenSignals(symbol, openRow.id);
    tracker.resumeTrade(openRow);
    console.log(`[resume] ${symbol}: reattached open ${openRow.direction} from ${openRow.entry_ts} (signal #${openRow.id})`);
  }
}

// ---- WebSocket (Socket.IO) -------------------------------------------------
const TF_KEY = { '1m': 'm1', '15m': 'm15' };
// Bug fix (2026-08-25, caught live via the [check] diagnostic log): Pi42 sometimes delivers a
// LATE/duplicate close event for an already-finalized bar, arriving AFTER the next period has
// already started forming. The original code treated that late event's timestamp mismatch as a
// genuine rollover and spuriously finalized the barely-started NEXT bar right then -- observed
// live as zero-width bars (icHigh === icLow, a single early tick mislabeled as a full closed
// bar), which are trivially "inside" almost anything and falsely triggered PENDING states.
// Fixed by rejecting any kline event whose timestamp is <= the last finalized timestamp for that
// symbol+timeframe BEFORE it can touch the rollover/forming logic at all -- late data is just
// dropped, not allowed to reopen or re-finalize anything.
const lastFinalizedTs = {}; // `${symbol}:${tfKey}` -> last finalized bar's timestampMs
// (2026-08-25 21:15 IST: this exact build failed 4x identically at the "railpack prepare" stage
// with the same content hash each time -- forcing a hash change here to rule out a stuck/bad
// Railway build cache entry rather than a real problem with the code, which node --check already
// confirmed is syntactically valid.)

function onKlineEvent(payload) {
  const symbol = (payload.ps || payload.s || '').toUpperCase();
  const interval = payload.k && payload.k.i;
  const tfKey = TF_KEY[interval];
  if (!symbol || !tfKey || !trackers[symbol]) return;

  const k = payload.k;
  const barTs = Number(k.t);
  const formKey = `${symbol}:${tfKey}`;
  if (lastFinalizedTs[formKey] != null && barTs <= lastFinalizedTs[formKey]) return; // late/duplicate -- drop

  const bar = { timestampMs: barTs, open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v || 0) };
  const prev = forming[formKey];

  const isNewBar = !prev || prev.timestampMs !== barTs;
  const isClosed = k.x === true;

  if (isNewBar && prev) finalizeBar(symbol, tfKey, prev);
  forming[formKey] = bar;
  if (isClosed) { finalizeBar(symbol, tfKey, bar); delete forming[formKey]; }
}

function finalizeBar(symbol, tfKey, bar) {
  const formKey = `${symbol}:${tfKey}`;
  if (lastFinalizedTs[formKey] === bar.timestampMs) return; // duplicate close event -- ignore
  lastFinalizedTs[formKey] = bar.timestampMs;
  const tracker = trackers[symbol];
  if (tfKey === 'm1') {
    enqueue(symbol, tracker.addM1Bar(bar));
  } else {
    enqueue(symbol, tracker.addM15Bar(bar));
  }
}

function subscribeTopics(socket, symbols) {
  const topics = [];
  for (const s of symbols) {
    const lower = s.toLowerCase();
    for (const interval of ['1m', '15m']) topics.push(`${lower}@kline_${interval}`);
  }
  socket.emit('subscribe', { params: topics });
  console.log('Subscribed:', topics.join(', '));
}

function connectAndRun(isFirstConnect, allSymbols) {
  return new Promise((resolve) => {
    const socket = io(WS_URL, { transports: ['websocket'], reconnection: false, timeout: 15000 });
    let settled = false;
    const finish = (reason) => { if (!settled) { settled = true; try { socket.close(); } catch (_) {} resolve(reason); } };

    socket.on('connect', async () => {
      console.log('Connected to Pi42 public WebSocket.');
      subscribeTopics(socket, allSymbols);
      if (isFirstConnect) {
        await emit('STARTUP', null, `🚀 Inside Candle Sweep+Break scanner started (15m/1m, ${R_TARGET}R target). New entries on: ${ENTRY_SYMBOLS.join(', ')}. Alert-only, no orders.`, null);
      } else {
        await emit('RECONNECTED', null, `🔌 Pi42 WebSocket reconnected after a network blip. Tracking continues uninterrupted -- no history lost, no positions reset.`, null);
      }
    });
    socket.on('kline', (payload) => { try { onKlineEvent(payload); } catch (e) { console.warn('kline handler error:', e.message); } });
    socket.on('connect_error', (err) => { console.error('WebSocket connect_error:', err.message); finish('connect_error'); });
    socket.on('disconnect', (reason) => { console.log('Disconnected:', reason); finish('disconnect'); });
    process.once('SIGTERM', () => finish('sigterm'));
    process.once('SIGINT', () => finish('sigint'));
  });
}

async function main() {
  console.log('Initializing Inside Candle Sweep+Break scanner (Pi42, alert-only)...');
  await db.init();

  for (const symbol of ENTRY_SYMBOLS) {
    try { await seedSymbol(symbol); }
    catch (e) { console.error(`FATAL: could not seed history for ${symbol}:`, e.message); process.exit(1); }
  }

  let attempt = 0;
  for (;;) {
    const reason = await connectAndRun(attempt === 0, ENTRY_SYMBOLS);
    if (reason === 'sigterm' || reason === 'sigint') { console.log('Shutting down (', reason, ').'); process.exit(0); }
    attempt++;
    const delayMs = Math.min(15000 * attempt, 120000);
    console.log(`Connection ended (${reason}). Reconnecting in ${delayMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

setInterval(() => {
  for (const t of Object.values(trackers)) {
    if (t.m15.length > MAX_BARS_KEPT) t.m15 = t.m15.slice(t.m15.length - MAX_BARS_KEPT);
  }
}, 30 * 60 * 1000).unref();
