'use strict';

/**
 * Live Inside Candle Sweep+Break scanner for BTCINR/XAUINR/SOLINR/XAGINR on Pi42.
 *
 * Data source: Pi42's PUBLIC market data only, same pattern as
 * ichimoku-btc-xau-strategy/live/streamer.js. Two price sources, selected by `PRICE_SOURCE` env
 * (default `MARK_PRICE`, see 2026-08-30 note below):
 *   - `LAST_PRICE`: History seed via REST (priceType=LAST_PRICE), live bars from Pi42's own
 *     pre-built `{pair}@kline_{interval}` WebSocket topic.
 *   - `MARK_PRICE`: History seed via REST (priceType=MARK_PRICE), live bars built HERE from
 *     Pi42's raw `{pair}@markPrice` tick stream (~1/sec, single price field `p`) -- Pi42 has no
 *     ready-made Mark Price *kline* topic, so tick_aggregator.js does the OHLC bucketing that
 *     Pi42 does for us on the Last-Price side. Confirmed empirically that tick field `p` matches
 *     the REST MARK_PRICE kline close exactly.
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
 * Mark Price switch (2026-08-30): a 62-day backtest (after fixing a pagination bug that had been
 * silently truncating history to ~35 days, see pi42_client.js) showed Mark Price net +28.88%
 * across all six symbols/four timeframes vs Last Price's -29.24% on the identical rule -- broad
 * (23/24 symbol-timeframe combos positive on 5m/15m/30m), not one outlier. Before building this,
 * verified entry/stop/trail-exit price levels computed from Mark Price were actually reachable on
 * Last Price (the real tradeable market) 99%+ of the time with sub-1% gaps -- so the advantage
 * isn't an artifact of assuming fills at prices you can't get. `PRICE_SOURCE=LAST_PRICE` reverts
 * to the original behaviour if needed.
 *
 * Alert-only. NO orders are ever placed -- this file makes zero authenticated
 * Pi42 requests, same boundary as every sibling strategy in this repo.
 *
 * Requires: TELEGRAM_BOT_TOKEN and DATABASE_URL (or .secrets/pg_url.txt) to
 * get alerts/persistence; runs (streams + logs to console) without either.
 */

// Must run BEFORE requiring pi42_client.js -- its PRICE_TYPE constant is captured once at
// module-load time from PI42_PRICE_TYPE. Deriving it from the single PRICE_SOURCE switch here
// (rather than requiring two separately-set env vars) is deliberate: two independent env vars
// that must agree is exactly the kind of thing that caused the 2026-08-26 seed/live price-type
// mismatch bug in the first place.
const PRICE_SOURCE = process.env.PRICE_SOURCE || 'MARK_PRICE'; // 'MARK_PRICE' | 'LAST_PRICE'
process.env.PI42_PRICE_TYPE = PRICE_SOURCE;

const { io } = require('socket.io-client');

const { IcSymbolTracker, R_TARGET, TREND_FILTER_ENABLED } = require('./ic_engine');
const { fetchKlines } = require('./pi42_client');
const { TickAggregator } = require('./tick_aggregator');
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
// Per-(symbol, timeframe) entry kill-switch -- the tracker still seeds history, watches, and logs
// diagnostics (so it's easy to re-enable later without losing continuity), it just never actually
// fires an entry. SOLINR:5m disabled 2026-08-29 after a 45-day backtest showed a real, not-just-
// unlucky negative edge there (13.3% win rate, -25.37R over 60 trades).
//
// XAUINR:5m and BTCINR:5m disabled 2026-08-31 after discovering the "tiny-risk-trade" R-multiple
// artifact (see MIN_RISK_PCT below): a 62-day clean backtest (filtering setups with risk < 0.05%
// of price) showed their previously-reported strong 5m edge was almost entirely that artifact --
// XAUINR:5m collapsed from a reported +165.11R to a real +6.69R (96% artifact), BTCINR:5m from
// +33.59R to +6.24R (81% artifact) -- both statistically indistinguishable from noise over
// 43-53 clean trades. MIN_RISK_PCT (added same day) should prevent NEW tiny-risk setups from
// arming at all going forward; these two are disabled on top of that because their entire
// historical track record was built on the artifact, not validated real performance -- re-enable
// only after MIN_RISK_PCT has accumulated its own live sample on these pairs.
const DISABLED_ENTRIES = new Set((process.env.DISABLED_ENTRIES || 'SOLINR:5m,XAUINR:5m,BTCINR:5m').split(',').map((s) => s.trim()).filter(Boolean));
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
// rollover-detection idiom as ichimoku-btc-xau-strategy/live/streamer.js. Only used for the
// LAST_PRICE (kline-topic) path -- MARK_PRICE builds its own forming state inside TickAggregator.
const forming = {}; // `${symbol}:${tfKey}` -> { timestampMs, open, high, low, close, volume }
const tickAggregators = {}; // symbol -> TickAggregator, MARK_PRICE path only

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
    `Floor (${R_TARGET}R min, then trails) ${fmtPx(e.target)}`,
    `${istLikeUtc(e.entryTs)} · alert-only, no order placed.`,
  ].filter(Boolean).join('\n');
}
// stats = { count, winRate, cumPnlPct } from db.getStats() -- prepended so every outcome alert
// carries the strategy's live track record, not just this one trade's result. AFTER this trade
// is included (see handleEvents: db.closeOutcome runs before db.getStats() is called). Combined
// across ALL timeframes deliberately (whole-strategy track record, not split by 15m/5m).
function fmtOutcome(e, stats) {
  const icon = e.result === 'SL' ? '🛑' : '✅'; // TARGET and TRAIL both win-style icons
  const resultLabel = e.result === 'TRAIL' ? 'TRAILED OUT' : e.result;
  const pct = pnlPct(e.direction, e.entryPx, e.exitPx);
  const lines = [];
  if (stats && stats.count > 0) {
    lines.push(`📊 Inside Candle so far: ${stats.winRate}% win rate (${stats.count} trades) · cum P&L ${stats.cumPnlPct >= 0 ? '+' : ''}${stats.cumPnlPct}%`);
  }
  lines.push(
    `${icon} ${e.symbol} (${e.signalTf}) closed — ${resultLabel} @ ${fmtPx(e.exitPx)}`,
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
    } else if (e.type === 'TRAIL_ACTIVATED') {
      // Reached the R_TARGET floor, switched into EMA-trail mode -- persist so a restart
      // mid-trail resumes correctly (db.js#activateTrailing, ic_engine.js#resumeTrade).
      // Console-only, no Telegram ping -- keeping alert volume down per explicit request.
      await db.activateTrailing(signalIds[trackerKey]);
      console.log(`[trail] ${e.symbol} (${e.signalTf}) ${e.direction} reached ${e.floorR}R floor, now trailing via EMA${e.emaLength}`);
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
  const entriesEnabled = ENTRY_SYMBOLS.includes(symbol) && !DISABLED_ENTRIES.has(trackerKey);
  const tracker = new IcSymbolTracker(symbol, { entriesEnabled, signalTf: tf });
  const bars = await fetchKlines(symbol, tf, SEED_BARS);
  tracker.seedHistory(bars);
  trackers[trackerKey] = tracker;
  if (bars.length) forming[`${symbol}:${tf}`] = { ...bars[bars.length - 1] };
  console.log(`[seed] ${trackerKey}: ${bars.length} bars${entriesEnabled ? '' : ' (entries DISABLED -- watching only)'}`);

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

// ---- MARK_PRICE tick path -----------------------------------------------
// `p` confirmed empirically (2026-08-30) to match the REST MARK_PRICE kline close exactly.
function onMarkPriceTick(payload) {
  const symbol = (payload.s || '').toUpperCase();
  const agg = tickAggregators[symbol];
  if (!agg) return; // stray topic echo for a symbol we didn't seed
  const price = Number(payload.p);
  const ts = Number(payload.E);
  if (!Number.isFinite(price) || !Number.isFinite(ts)) return;
  const closed = agg.addTick(price, ts);
  for (const { tf, bar } of closed) finalizeBar(symbol, tf, bar);
}

function subscribeTopics(socket, symbols) {
  const topics = [];
  for (const s of symbols) {
    const lower = s.toLowerCase();
    if (PRICE_SOURCE === 'MARK_PRICE') {
      topics.push(`${lower}@markPrice`);
    } else {
      for (const interval of ['1m', ...SIGNAL_TIMEFRAMES]) topics.push(`${lower}@kline_${interval}`);
    }
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
        const trendMsg = TREND_FILTER_ENABLED ? 'trend-filtered' : 'no trend filter';
        await emit('STARTUP', null, `🚀 Inside Candle Sweep+Break scanner started (${SIGNAL_TIMEFRAMES.join('/')} + 1m, ${PRICE_SOURCE}, ${R_TARGET}R floor + EMA trail, ${trendMsg}). New entries on: ${ENTRY_SYMBOLS.join(', ')}. Alert-only, no orders.`, null);
      } else {
        await emit('RECONNECTED', null, `🔌 Pi42 WebSocket reconnected after a network blip. Tracking continues uninterrupted -- no history lost, no positions reset.`, null);
      }
    });
    if (PRICE_SOURCE === 'MARK_PRICE') {
      socket.on('markPriceUpdate', (payload) => { try { onMarkPriceTick(payload); } catch (e) { console.warn('markPriceUpdate handler error:', e.message); } });
    } else {
      socket.on('kline', (payload) => { try { onKlineEvent(payload); } catch (e) { console.warn('kline handler error:', e.message); } });
    }
    socket.on('connect_error', (err) => { console.error('WebSocket connect_error:', err.message); finish('connect_error'); });
    socket.on('disconnect', (reason) => { console.log('Disconnected:', reason); finish('disconnect'); });
    process.once('SIGTERM', () => finish('sigterm'));
    process.once('SIGINT', () => finish('sigint'));
  });
}

async function main() {
  console.log(`Initializing Inside Candle Sweep+Break scanner (Pi42, alert-only, ${PRICE_SOURCE})...`);
  await db.init();

  if (PRICE_SOURCE === 'MARK_PRICE') {
    for (const symbol of ENTRY_SYMBOLS) tickAggregators[symbol] = new TickAggregator(symbol, ['1m', ...SIGNAL_TIMEFRAMES]);
  }

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
