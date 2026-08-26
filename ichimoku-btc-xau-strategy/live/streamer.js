'use strict';

/**
 * Live Ichimoku MTF (1H/30min/5min) scanner for BTCUSDT and XAUUSDT on Pi42.
 *
 * Data source: Pi42's PUBLIC market data only.
 *   - History seed: POST /v1/market/klines (REST, unauthenticated) -- see pi42_client.js.
 *   - Live bars: the public WebSocket at https://fawss.pi42.com/, which is
 *     Socket.IO (not raw ws) -- confirmed empirically 2026-08-21 with a
 *     throwaway test script (socket.io-client connected, subscribed to
 *     `btcusdt@kline_1m`/`btcusdt@markPrice`, and received live
 *     `kline`/`markPriceUpdate` events within ~1s). A parallel raw-`ws`
 *     attempt at the engine.io upgrade URL was NOT tried further once
 *     socket.io-client worked cleanly -- see README "WebSocket transport"
 *     for the full writeup. No polling fallback was needed.
 *
 * Strategy: wiki/concepts/ichimoku-cloud.md "Trading strategy — multi-
 * timeframe (MTF) trend system", wiki/sources/secretmindset-ichimoku-mtf-
 * strategy-video.md. Engine: mtf_engine.js.
 *
 * Alert-only. NO orders are ever placed -- this file makes zero authenticated
 * Pi42 requests.
 *
 * Requires: TELEGRAM_BOT_TOKEN and DATABASE_URL (or .secrets/pg_url.txt) to
 * get alerts/persistence; runs (streams + logs to console) without either.
 */

const { io } = require('socket.io-client');

const { MtfSymbolTracker, TARGET_R, STOP_BUFFER_PCT } = require('./mtf_engine');
const { fetchKlines } = require('./pi42_client');
const { DB } = require('./db');
const { pnlPct } = require('./stats');

// ENTRY_SYMBOLS = where NEW setups are allowed to fire. Switched 2026-08-23 from
// BTCUSDT/XAUUSDT to the INR-margined equivalents (BTCINR/XAUINR -- same underlying
// products, confirmed via exchangeInfo: XAUINR is the same "Gold Derivatives"
// TRADIFI_PERPETUAL contract as XAUUSDT, just INR-quoted, not a tokenized-gold
// footgun like XAUTINR/PAXGINR). Per the user's explicit request, this was NOT a
// blind swap -- any symbol with a still-OPEN position at startup keeps being
// tracked (just without new entries) until it actually resolves; see
// MtfSymbolTracker's entriesEnabled and main()'s ALL_SYMBOLS resolution below.
const ENTRY_SYMBOLS = ['BTCINR', 'XAUINR'];
const WS_URL = 'https://fawss.pi42.com/';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046']; // personal + group, same as every sibling bot

// History seeding depths -- see README "History seeding" for the reasoning.
const SEED = { h1: 100, m30: 100, m5: 300 };
const TF_INTERVAL = { h1: '1h', m30: '30m', m5: '5m' };
const MAX_BARS_KEPT = 2000; // per timeframe per symbol, memory cap for a long-running process

if (!TELEGRAM_TOKEN) console.warn('WARNING: TELEGRAM_BOT_TOKEN not set. Alerts logged, not sent.');

const db = new DB();
const trackers = {}; // symbol -> MtfSymbolTracker
const signalIds = {}; // symbol -> latest Postgres signals.id
// Per-symbol, per-timeframe "currently forming" bar, keyed by its startTime (ms) -- used to
// detect a bar rollover (new startTime, or an explicit close flag) and finalize the previous one.
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
    `${e.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} ICHIMOKU MTF SETUP — ${e.symbol}`,
    `1H: ${e.criteria.h1}  |  30m: ${e.criteria.m30}  |  5m trigger: ${e.criteria.m5Trigger}  |  invalidation gate: ${e.criteria.invalidationGate}`,
    `Entry ${fmtPx(e.entryPx)}  |  Stop ${fmtPx(e.stop)} (200EMA ${fmtPx(e.ema200At)} ± ${(STOP_BUFFER_PCT * 100).toFixed(2)}% buffer)  |  R ${fmtPx(e.r)}`,
    `Target (${TARGET_R}R) ${fmtPx(e.target)}`,
    `${istLikeUtc(e.entryTs)} · alert-only, no order placed.`,
  ].join('\n');
}
// stats = { count, winRate, cumPnlPct } from db.getStats() -- prepended so every outcome alert
// carries the strategy's live track record, not just this one trade's result. AFTER this trade
// is included (see handleEvents: db.closeOutcome runs before db.getStats() is called).
function fmtOutcome(e, stats) {
  const icon = e.result === 'TARGET' ? '✅' : e.result === 'WARNING_EXIT' ? '⚠️' : '🛑';
  const label = e.result === 'WARNING_EXIT' ? 'EARLY REVERSAL EXIT' : e.result;
  const pct = pnlPct(e.direction, e.entryPx, e.exitPx);
  const lines = [];
  if (stats && stats.count > 0) {
    lines.push(`📊 Ichimoku so far: ${stats.winRate}% win rate (${stats.count} trades) · cum P&L ${stats.cumPnlPct >= 0 ? '+' : ''}${stats.cumPnlPct}%`);
  }
  lines.push(`${icon} ${e.symbol} closed — ${label} @ ${fmtPx(e.exitPx)}`);
  if (e.result === 'WARNING_EXIT') {
    lines.push(`Baseline (Kijun) crossed back through the 200 EMA against the position (kijun ${fmtPx(e.kijun)} vs ema200 ${fmtPx(e.ema200)}) — closed immediately, not just flagged.`);
  }
  lines.push(
    `P&L: ${pct != null ? `${pct >= 0 ? '+' : ''}${pct}%` : '—'}  |  R-multiple: ${e.rMultiple >= 0 ? '+' : ''}${Number(e.rMultiple).toFixed(2)}R  ·  MFE ${Number(e.mfeR).toFixed(2)}R / MAE ${Number(e.maeR).toFixed(2)}R`,
    `${istLikeUtc(e.closedTs)}.`,
  );
  return lines.join('\n');
}

// Console-only (no Telegram, no DB) -- one line per completed bar entry is evaluated
// on, so `railway logs` can answer "why didn't it fire between X and Y" definitively
// instead of only from whatever the live state happens to be when someone asks.
function fmtDiagnostic(e) {
  const when = istLikeUtc(e.ts);
  if (!e.lookbackReady) return `[check] ${e.symbol} ${when} close=${fmtPx(e.close)} -- insufficient lookback yet`;
  const side = (s) => (s.aboveCloudAndBaseline ? 'above' : s.belowCloudAndBaseline ? 'below' : 'INSIDE-cloud');
  const h1 = side(e.h1);
  const m30 = `${side(e.m30)}${e.m30.cloudGreen ? '+green' : e.m30.cloudRed ? '+red' : '+neither'}`;
  const m5 = e.m5.kijunAboveEma ? 'kijun>ema' : e.m5.kijunBelowEma ? 'kijun<ema' : 'kijun=ema';
  const gate = e.m5.invalidated ? 'INVALIDATED' : 'clear';
  return `[check] ${e.symbol} ${when} close=${fmtPx(e.close)} | 1H:${h1} 30m:${m30} 5m:${m5} gate:${gate} | longOk=${e.longOk} shortOk=${e.shortOk}`;
}

async function emit(alertType, symbol, text, signalId) {
  const ok = await sendTelegram(text);
  await db.insertAlert({ signalId, symbol, alertType, chatId: TELEGRAM_CHAT_IDS.join(','), text, sentOk: ok });
}

async function handleEvents(events) {
  for (const e of events) {
    if (e.type === 'SETUP') {
      const id = await db.insertSignal(e, STOP_BUFFER_PCT * 100);
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
  const tracker = new MtfSymbolTracker(symbol, { entriesEnabled: ENTRY_SYMBOLS.includes(symbol) });
  const [h1, m30, m5] = await Promise.all([
    fetchKlines(symbol, TF_INTERVAL.h1, SEED.h1),
    fetchKlines(symbol, TF_INTERVAL.m30, SEED.m30),
    fetchKlines(symbol, TF_INTERVAL.m5, SEED.m5),
  ]);
  tracker.seedHistory({ h1, m30, m5 });
  trackers[symbol] = tracker;
  // Seed the "forming bar" trackers with the latest fetched bar so the WS
  // stream's first update for that timeframe is treated as a continuation,
  // not spuriously finalized as a new bar with only partial data.
  if (h1.length) forming[`${symbol}:h1`] = { ...h1[h1.length - 1] };
  if (m30.length) forming[`${symbol}:m30`] = { ...m30[m30.length - 1] };
  if (m5.length) forming[`${symbol}:m5`] = { ...m5[m5.length - 1] };
  console.log(`[seed] ${symbol}: 1h=${h1.length} 30m=${m30.length} 5m=${m5.length} bars`);

  // Resume any still-OPEN position from a prior process run (see mtf_engine.js
  // #resumeTrade -- without this, every restart forgot the open trade and
  // re-entered fresh, producing duplicate signals and orphaning the original's
  // outcome forever; fixed 2026-08-21).
  const openRow = await db.getOpenSignal(symbol);
  if (openRow) {
    signalIds[symbol] = Number(openRow.id);
    await db.abandonOtherOpenSignals(symbol, openRow.id);
    const events = tracker.resumeTrade(openRow);
    console.log(`[resume] ${symbol}: reattached open ${openRow.direction} from ${openRow.entry_ts} (signal #${openRow.id})`);
    if (events.length) enqueue(symbol, events); // e.g. it already hit stop/target/warning while we were down
  }
}

// ---- WebSocket (Socket.IO) -------------------------------------------------
const TF_KEY = { '1m': null, '5m': 'm5', '30m': 'm30', '1h': 'h1' }; // Pi42 interval string -> our tf key
const TF_ADD_METHOD = { m5: 'addM5Bar', m30: 'addM30Bar', h1: 'addH1Bar' };

function onKlineEvent(payload) {
  const symbol = (payload.ps || payload.s || '').toUpperCase();
  const interval = payload.k && payload.k.i;
  const tfKey = TF_KEY[interval];
  if (!symbol || !tfKey || !trackers[symbol]) return; // ignore intervals/symbols we didn't ask for

  const k = payload.k;
  const barTs = Number(k.t);
  const bar = { timestampMs: barTs, open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v || 0) };
  const formKey = `${symbol}:${tfKey}`;
  const prev = forming[formKey];

  const isNewBar = !prev || prev.timestampMs !== barTs;
  const isClosed = k.x === true;

  if (isNewBar && prev) finalizeBar(symbol, tfKey, prev); // rollover: the previous forming bar is now complete
  forming[formKey] = bar;
  if (isClosed) { finalizeBar(symbol, tfKey, bar); delete forming[formKey]; }
}

function finalizeBar(symbol, tfKey, bar) {
  if (tfKey === 'm5') {
    enqueue(symbol, trackers[symbol].addM5Bar(bar));
  } else {
    trackers[symbol][TF_ADD_METHOD[tfKey]](bar);
  }
}

function subscribeTopics(socket, symbols) {
  const topics = [];
  for (const s of symbols) {
    const lower = s.toLowerCase();
    for (const interval of ['5m', '30m', '1h']) topics.push(`${lower}@kline_${interval}`);
  }
  socket.emit('subscribe', { params: topics });
  console.log('Subscribed:', topics.join(', '));
}

function connectAndRun(isFirstConnect, allSymbols, legacySymbols) {
  return new Promise((resolve) => {
    const socket = io(WS_URL, { transports: ['websocket'], reconnection: false, timeout: 15000 });
    let settled = false;
    const finish = (reason) => { if (!settled) { settled = true; try { socket.close(); } catch (_) {} resolve(reason); } };

    socket.on('connect', async () => {
      console.log('Connected to Pi42 public WebSocket.');
      subscribeTopics(socket, allSymbols);
      // Fires on every successful connect, including reconnects after a transient WS
      // drop -- not just the true process boot. Distinguish the wording (2026-08-22,
      // caught after a user got confused by a "scanner started" alert mid-day for what
      // was actually just a network blip) so a reconnect never claims the process
      // restarted, since nothing was actually re-seeded/re-resumed on a mere WS bounce.
      if (isFirstConnect) {
        const legacyNote = legacySymbols.length
          ? ` Also finishing out an already-open position on ${legacySymbols.join(', ')} (no new entries there).`
          : '';
        await emit('STARTUP', null, `🚀 Ichimoku BTC/XAU MTF scanner started. New entries on: ${ENTRY_SYMBOLS.join(', ')}.${legacyNote} Alert-only, no orders.`, null);
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
  console.log('Initializing Ichimoku BTC/XAU MTF scanner (Pi42, alert-only)...');
  await db.init();

  // Phase-out resolution: any symbol with a currently-OPEN position that's NOT in
  // ENTRY_SYMBOLS still needs seeding/subscribing/tracking (to reach a real
  // outcome), it just never gets entriesEnabled. See seedSymbol()'s MtfSymbolTracker
  // construction and mtf_engine.js's class doc comment.
  const openSymbols = await db.getOpenSymbols();
  const legacySymbols = openSymbols.filter((s) => !ENTRY_SYMBOLS.includes(s));
  const allSymbols = [...ENTRY_SYMBOLS, ...legacySymbols];
  if (legacySymbols.length) console.log(`[phase-out] still tracking (no new entries) until resolved: ${legacySymbols.join(', ')}`);

  for (const symbol of allSymbols) {
    try { await seedSymbol(symbol); }
    catch (e) { console.error(`FATAL: could not seed history for ${symbol}:`, e.message); process.exit(1); }
  }

  let attempt = 0;
  for (;;) {
    const reason = await connectAndRun(attempt === 0, allSymbols, legacySymbols);
    if (reason === 'sigterm' || reason === 'sigint') { console.log('Shutting down (', reason, ').'); process.exit(0); }
    attempt++;
    const delayMs = Math.min(15000 * attempt, 120000);
    console.log(`Connection ended (${reason}). Reconnecting in ${delayMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

// Trim in-memory bar arrays occasionally so a long-running process doesn't grow unbounded.
setInterval(() => {
  for (const t of Object.values(trackers)) {
    for (const tf of ['h1', 'm30', 'm5']) {
      if (t[tf].length > MAX_BARS_KEPT) t[tf] = t[tf].slice(t[tf].length - MAX_BARS_KEPT);
    }
  }
}, 30 * 60 * 1000).unref();
