'use strict';

/**
 * Live Inside Candle Sweep+Break scanner for BTCINR/XAUINR/SOLINR/XAGINR on Pi42.
 *
 * Data source: Pi42's PUBLIC market data only, same pattern as
 * ichimoku-btc-xau-strategy/live/streamer.js:
 *   - History seed: POST /v1/market/klines (REST, unauthenticated) -- pi42_client.js.
 *   - Live bars: the public Socket.IO WebSocket at https://fawss.pi42.com/,
 *     subscribed to `{symbol}@kline_1m` plus one topic per entry in SIGNAL_TIMEFRAMES.
 *
 * Strategy: wiki/concepts/inside-candle-liquidity-sweep-scalp.md +
 * wiki/reference/inside-candle-next-candle-trend-filtered.pine (the validated
 * Pine version this is a direct port of). Engine: ic_engine.js.
 *
 * Multi-timeframe (2026-08-28): runs 15m AND 5m concurrently per symbol -- ic_engine.js's
 * IcSymbolTracker is internally timeframe-agnostic, so this file just instantiates ONE tracker
 * per (symbol, timeframe) pair and routes bars to the right one(s). Every 1-minute bar is fed to
 * ALL of a symbol's trackers (each needs it independently for intrabar sweep-sequencing); a
 * closed 15m/5m bar is fed only to its own matching tracker. `SIGNAL_TIMEFRAMES` env
 * (comma-separated, default `15m,5m`) controls which timeframes run.
 *
 * Alert-only. NO orders are ever placed -- this file makes zero authenticated
 * Pi42 requests, same boundary as every sibling strategy in this repo.
 *
 * Requires: TELEGRAM_BOT_TOKEN and DATABASE_URL (or .secrets/pg_url.txt) to
 * get alerts/persistence; runs (streams + logs to console) without either.
 */

const { io } = require('socket.io-client');

const { IcSymbolTracker, R_TARGET, TREND_FILTER_ENABLED, SWING_LOOKBACK, EMA_LENGTH } = require('./ic_engine');
const { fetchKlines } = require('./pi42_client');
const { DB } = require('./db');
const { pnlPct } = require('./stats');

// BTCINR/XAUINR: same INR-margined pairs as ichimoku-btc-xau-strategy (per the user's explicit
// request there -- see that strategy's README "Symbol-set switch: BTCUSDT/XAUUSDT -> BTCINR/XAUINR").
// SOLINR/XAGINR added 2026-08-26 per explicit request -- Inside Candle only for now (not mirrored
// to Ichimoku), one crypto (Solana, more volatile than BTC/ETH) and one commodity (Silver, same
// TRADIFI_PERPETUAL class as gold, the natural precious-metals pairing with XAUINR).
const ENTRY_SYMBOLS = ['BTCINR', 'XAUINR', 'SOLINR', 'XAGINR'];
// Which "signal timeframes" run concurrently, per symbol -- each gets its own fully independent
// IcSymbolTracker (own EMA, own pending/sweep state). 5m added 2026-08-28 per explicit request
// (originally scoped as 30m, changed to 5m before implementation).
const SIGNAL_TIMEFRAMES = (process.env.SIGNAL_TIMEFRAMES || '15m,5m').split(',').map((s) => s.trim()).filter(Boolean);
const WS_URL = 'https://fawss.pi42.com/';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046']; // personal + group, same as every sibling bot

const SEED_BARS = 100; // enough history for the inside-candle check plus some dashboard-worthy context (per timeframe)
const MAX_BARS_KEPT = 2000; // memory cap for a long-running process (per tracker)

if (!TELEGRAM_TOKEN) console.warn('WARNING: TELEGRAM_BOT_TOKEN not set. Alerts logged, not sent.');

const db = new DB();
const trackers = {}; // `${symbol}:${tf}` -> IcSymbolTracker
const signalIds = {}; // `${symbol}:${tf}` -> latest Postgres signals.id
// Per-symbol, per-timeframe "currently forming" bar, keyed by its startTime (ms) -- same
// rollover-detection idiom as ichimoku-btc-xau-strategy/live/streamer.js.
const forming = {}; // `${symbol}:${tfKey}` -> { timestampMs, open, high, low, close, volume }

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
    `${e.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} INSIDE CANDLE SWEEP+BREAK — ${e.symbol} (${e.signalTf})`,
    `IC high ${fmtPx(e.icHigh)}  |  IC low ${fmtPx(e.icLow)}`,
    `Entry ${fmtPx(e.entryPx)}  |  Stop ${fmtPx(e.stop)}  |  R ${fmtPx(e.r)}`,
    `Target (${R_TARGET}R) ${fmtPx(e.target)}`,
    TREND_FILTER_ENABLED ? `Trend-filtered entry (EMA${EMA_LENGTH}, swing lookback ${SWING_LOOKBACK}).` : null,
    `${istLikeUtc(e.entryTs)} · alert-only, no order placed.`,
  ].filter(Boolean).join('\n');
}
// stats = { count, winRate, cumPnlPct } from db.getStats() -- prepended so every outcome alert
// carries the strategy's live track record, not just this one trade's result. AFTER this trade
// is included (see handleEvents: db.closeOutcome runs before db.getStats() is called). Combined
// across ALL timeframes deliberately (whole-strategy track record, not split by 15m/5m).
function fmtOutcome(e, stats) {
  const icon = e.result === 'TARGET' ? '✅' : '🛑';
  const pct = pnlPct(e.direction, e.entryPx, e.exitPx);
  const lines = [];
  if (stats && stats.count > 0) {
    lines.push(`📊 Inside Candle so far: ${stats.winRate}% win rate (${stats.count} trades) · cum P&L ${stats.cumPnlPct >= 0 ? '+' : ''}${stats.cumPnlPct}%`);
  }
  lines.push(
    `${icon} ${e.symbol} (${e.signalTf}) closed — ${e.result} @ ${fmtPx(e.exitPx)}`,
    `P&L: ${pct != null ? `${pct >= 0 ? '+' : ''}${pct}%` : '—'}  |  R-multiple: ${e.rMultiple >= 0 ? '+' : ''}${Number(e.rMultiple).toFixed(2)}R`,
    `${istLikeUtc(e.closedTs)}.`,
  );
  return lines.join('\n');
}

// Console-only (no Telegram, no DB) -- one line per closed signal-timeframe bar, so `railway logs`
// can confirm the bot is actually receiving/processing live data, not just sitting connected.
function fmtDiagnostic(e) {
  const when = istLikeUtc(e.ts);
  const state = e.openTrade ? 'in-trade' : e.nowPending ? `PENDING (IC ${fmtPx(e.icLow)}-${fmtPx(e.icHigh)})` : e.wasPendingUnresolved ? 'window closed unresolved' : 'watching';
  return `[check] ${e.symbol} (${e.signalTf}) ${when} close=${fmtPx(e.close)} | inside=${e.isInside} | ${state}`;
}

async function emit(alertType, symbol, text, signalId) {
  const ok = await sendTelegram(text);
  await db.insertAlert({ signalId, symbol, alertType, chatId: TELEGRAM_CHAT_IDS.join(','), text, sentOk: ok });
}

async function handleEvents(events) {
  for (const e of events) {
    const trackerKey = `${e.symbol}:${e.signalTf}`;
    if (e.type === 'SETUP') {
      const id = await db.insertSignal(e);
      if (id != null) signalIds[trackerKey] = id;
      await emit('SETUP', e.symbol, fmtSetup(e), signalIds[trackerKey]);
    } else if (e.type === 'OUTCOME') {
      await db.closeOutcome(signalIds[trackerKey], e);
      const stats = await db.getStats(); // AFTER closeOutcome so this trade counts in the stats
      await emit(e.result, e.symbol, fmtOutcome(e, stats), signalIds[trackerKey]);
    } else if (e.type === 'DIAGNOSTIC') {
      console.log(fmtDiagnostic(e)); // server logs only -- no Telegram, no DB insert
    }
  }
}

// Serialize event handling per (symbol, timeframe) so a signal's INSERT always completes before
// its OUTCOME UPDATE, and so 15m/5m events for the same symbol never block on each other.
const chains = {};
function enqueue(trackerKey, events) {
  if (!events || events.length === 0) return;
  chains[trackerKey] = (chains[trackerKey] || Promise.resolve())
    .then(() => handleEvents(events))
    .catch((e) => console.error(`handleEvents error [${trackerKey}]:`, e.message));
}

// ---- history seeding ------------------------------------------------------
// One tracker per (symbol, signal-timeframe) pair -- e.g. BTCINR gets an independent 15m tracker
// AND an independent 5m tracker, each with its own EMA/swing/pending state.
async function seedSymbolTf(symbol, tf) {
  const trackerKey = `${symbol}:${tf}`;
  const tracker = new IcSymbolTracker(symbol, { entriesEnabled: ENTRY_SYMBOLS.includes(symbol), signalTf: tf });
  const bars = await fetchKlines(symbol, tf, SEED_BARS);
  tracker.seedHistory(bars);
  trackers[trackerKey] = tracker;
  if (bars.length) forming[`${symbol}:${tf}`] = { ...bars[bars.length - 1] };
  console.log(`[seed] ${trackerKey}: ${bars.length} bars`);

  // Resume any still-OPEN position from a prior process run (same restart-resilience pattern
  // as ichimoku-btc-xau-strategy -- see that strategy's README for the incident that motivated it).
  // Scoped by BOTH symbol and timeframe (db.js) -- 15m and 5m can each have their own genuinely
  // open trade at the same time, so this must never abandon the OTHER timeframe's real position.
  const openRow = await db.getOpenSignal(symbol, tf);
  if (openRow) {
    signalIds[trackerKey] = Number(openRow.id);
    await db.abandonOtherOpenSignals(symbol, tf, openRow.id);
    tracker.resumeTrade(openRow);
    console.log(`[resume] ${trackerKey}: reattached open ${openRow.direction} from ${openRow.entry_ts} (signal #${openRow.id})`);
  }
}

// ---- WebSocket (Socket.IO) -------------------------------------------------
// Bug fix (2026-08-25, caught live via the [check] diagnostic log): Pi42 sometimes delivers a
// LATE/duplicate close event for an already-finalized bar, arriving AFTER the next period has
// already started forming. The original code treated that late event's timestamp mismatch as a
// genuine rollover and spuriously finalized the barely-started NEXT bar right then -- observed
// live as zero-width bars (icHigh === icLow, a single early tick mislabeled as a full closed
// bar), which are trivially "inside" almost anything and falsely triggered PENDING states.
// Fixed by rejecting any kline event whose timestamp is <= the last finalized timestamp for that
// symbol+interval BEFORE it can touch the rollover/forming logic at all -- late data is just
// dropped, not allowed to reopen or re-finalize anything.
const lastFinalizedTs = {}; // `${symbol}:${interval}` -> last finalized bar's timestampMs
// (2026-08-25 21:15 IST: this exact build failed 4x identically at the "railpack prepare" stage
// with the same content hash each time -- forcing a hash change here to rule out a stuck/bad
// Railway build cache entry rather than a real problem with the code, which node --check already
// confirmed is syntactically valid.)

function onKlineEvent(payload) {
  const symbol = (payload.ps || payload.s || '').toUpperCase();
  const interval = payload.k && payload.k.i; // e.g. '1m', '15m', '5m' -- used directly as the key, no abbreviation layer
  const isSignalTf = SIGNAL_TIMEFRAMES.includes(interval);
  if (!symbol || !interval || (interval !== '1m' && !isSignalTf)) return;
  // Only care about symbols we actually seeded trackers for (skips any stray topic echoes).
  if (interval === '1m' ? !SIGNAL_TIMEFRAMES.some((tf) => trackers[`${symbol}:${tf}`]) : !trackers[`${symbol}:${interval}`]) return;

  const k = payload.k;
  const barTs = Number(k.t);
  const formKey = `${symbol}:${interval}`;
  if (lastFinalizedTs[formKey] != null && barTs <= lastFinalizedTs[formKey]) return; // late/duplicate -- drop

  const bar = { timestampMs: barTs, open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v || 0) };
  const prev = forming[formKey];

  const isNewBar = !prev || prev.timestampMs !== barTs;
  const isClosed = k.x === true;

  if (isNewBar && prev) finalizeBar(symbol, interval, prev);
  forming[formKey] = bar;
  if (isClosed) { finalizeBar(symbol, interval, bar); delete forming[formKey]; }
}

// `interval` is '1m' (fed to EVERY signal-timeframe tracker for this symbol, each needs it
// independently for intrabar sweep-sequencing) or one of SIGNAL_TIMEFRAMES (fed only to its own
// matching tracker).
function finalizeBar(symbol, interval, bar) {
  const formKey = `${symbol}:${interval}`;
  if (lastFinalizedTs[formKey] === bar.timestampMs) return; // duplicate close event -- ignore
  lastFinalizedTs[formKey] = bar.timestampMs;
  if (interval === '1m') {
    for (const tf of SIGNAL_TIMEFRAMES) {
      const trackerKey = `${symbol}:${tf}`;
      const tracker = trackers[trackerKey];
      if (tracker) enqueue(trackerKey, tracker.addM1Bar(bar));
    }
  } else {
    const trackerKey = `${symbol}:${interval}`;
    const tracker = trackers[trackerKey];
    if (tracker) enqueue(trackerKey, tracker.addM15Bar(bar));
  }
}

function subscribeTopics(socket, symbols) {
  const topics = [];
  for (const s of symbols) {
    const lower = s.toLowerCase();
    for (const interval of ['1m', ...SIGNAL_TIMEFRAMES]) topics.push(`${lower}@kline_${interval}`);
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
        const trendMsg = TREND_FILTER_ENABLED ? `trend-filtered, EMA${EMA_LENGTH}, swing lookback ${SWING_LOOKBACK}` : 'no trend filter';
        await emit('STARTUP', null, `🚀 Inside Candle Sweep+Break scanner started (${SIGNAL_TIMEFRAMES.join('/')} + 1m, ${R_TARGET}R target, ${trendMsg}). New entries on: ${ENTRY_SYMBOLS.join(', ')}. Alert-only, no orders.`, null);
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
    for (const tf of SIGNAL_TIMEFRAMES) {
      try { await seedSymbolTf(symbol, tf); }
      catch (e) { console.error(`FATAL: could not seed history for ${symbol}:${tf}:`, e.message); process.exit(1); }
    }
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
