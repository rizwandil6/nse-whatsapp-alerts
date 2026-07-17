'use strict';

/**
 * Live intraday streamer for the Opening Range Breakout strategy — 30x
 * volume confirmation, VWAP + Bollinger-middle-band trend confirmation,
 * 2% structural stop cap, and a dynamic Bollinger-Band-hugging exit (no
 * fixed target). See orb_engine.js for the full rules and the backtest
 * that validated this combination (526 trades, 77.8% net win, +0.699%
 * net avg — up from the original fixed-target version's 62.8%/+0.433%).
 * Connects to Upstox's official V3 market-data WebSocket feed and builds
 * 1-minute OHLCV bars ITSELF from raw LTPC ticks (see tick_bar_builder.js),
 * then feeds them into one ORBSymbolTracker per stock.
 *
 * Does NOT use Upstox's own pre-aggregated `marketOHLC` "I1" candle field
 * — live-diagnosed (2026-07-15) to lag their own tick stream by anywhere
 * from ~1-2 minutes up to several HOURS during a live session (a real
 * breakout at 09:42 wasn't alerted until 13:36 that day). The connection
 * itself was never the problem — LTPC.ltt tracked wall-clock closely the
 * whole time — only Upstox's server-side candle aggregation lagged.
 *
 * Also revises entry/stop against the freshest real price at alert-
 * dispatch time (see execution_revision.js) — built after a real
 * incident (ITI, 2026-07-16) where the theoretical OR-boundary entry was
 * already far behind actual price by the time the alert sent.
 *
 * No live orders placed. Alert-only.
 *
 * Requires UPSTOX_ACCESS_TOKEN and TELEGRAM_BOT_TOKEN env vars.
 */

const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('path');

const { ORBSymbolTracker } = require('./orb_engine');
const { TickBarBuilder } = require('./tick_bar_builder');
const { reviseEntryForLiveExecution, reviseExitForLiveExecution } = require('./execution_revision');
const { syncTradeLogFromRemote, recordTrade, pushTradeLogToGitHub } = require('./trade_log');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046'];
const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const TRADE_LOG_PUSH_AFTER_MIN = 15 * 60 + 35; // 15:35 IST — after the 15:30 EOD square-off, once/day only (see trade_log.js)
const TRADE_LOG_POLL_MS = 5 * 60 * 1000;

function istMinutesAndDate() {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return { minutesOfDay: ist.getUTCHours() * 60 + ist.getUTCMinutes(), dateStr: ist.toISOString().slice(0, 10) };
}

if (!UPSTOX_TOKEN) {
  console.error('FATAL: UPSTOX_ACCESS_TOKEN env var not set. Cannot start.');
  process.exit(1);
}
if (!TELEGRAM_TOKEN) {
  console.warn('WARNING: TELEGRAM_BOT_TOKEN not set. Alerts will be logged but not sent.');
}

const symbolMap = require('./symbols.json');
const keyToSymbol = {};
for (const [symbol, key] of Object.entries(symbolMap)) keyToSymbol[key] = symbol;

const FLUSH_POLL_MS = 15 * 1000; // how often to force-close forming bars whose minute has elapsed with no new tick (EOD, illiquid gaps)

let protobufRoot = null;
const trackers = {}; // symbol -> ORBSymbolTracker
const tickBuilders = {}; // symbol -> TickBarBuilder
const revisedPositions = {}; // symbol -> { entry, stop, direction } -- the REAL numbers actually alerted, used for honest exit P&L

async function getMarketFeedUrl() {
  const res = await fetch(AUTHORIZE_URL, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${UPSTOX_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Authorize failed: HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  return body.data.authorizedRedirectUri || body.data.authorized_redirect_uri;
}

async function initProtobuf() {
  protobufRoot = await protobuf.load(path.join(__dirname, 'MarketDataFeedV3.proto'));
}

function decodeProtobuf(buffer) {
  const FeedResponse = protobufRoot.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
  const message = FeedResponse.decode(buffer);
  return FeedResponse.toObject(message, { longs: Number, enums: String, defaults: true });
}

/**
 * Extracts a raw tick from a feed message. Used to build 1-minute bars
 * OURSELVES (see tick_bar_builder.js) rather than trusting Upstox's own
 * pre-aggregated `marketOHLC` "I1" candle field, which was live-diagnosed
 * (2026-07-15) to lag their own tick stream by anywhere from ~1-2 minutes
 * up to several HOURS during a live session — the connection/transport
 * was never the problem, `LTPC.ltt` tracked wall-clock closely (often to
 * the exact second) the whole time; only their server-side candle
 * aggregation lagged. Only marketFF (equities) carries LTPC/vtt/tbq/tsq —
 * indexFF (indices) is not used by this ORB universe, returns null.
 */
function extractTick(feed) {
  const fullFeed = feed.fullFeed;
  const marketFF = fullFeed && fullFeed.marketFF;
  if (!marketFF || !marketFF.ltpc) return null;
  return {
    ltp: marketFF.ltpc.ltp,
    lttMs: Number(marketFF.ltpc.ltt),
    vtt: Number(marketFF.vtt || 0),
    tbq: marketFF.tbq,
    tsq: marketFF.tsq,
  };
}

function getOrCreateTickBuilder(symbol) {
  if (!tickBuilders[symbol]) tickBuilders[symbol] = new TickBarBuilder();
  return tickBuilders[symbol];
}

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

function formatEntryAlert(e, revision) {
  const obLine =
    e.obImbalance != null
      ? `Order book: TBQ ${e.tbq} / TSQ ${e.tsq} (${(e.obImbalance * 100).toFixed(0)}% buy-side) — logged only, not used for entry`
      : 'Order book: n/a';
  const driftLine = !revision.livePriceAvailable
    ? `⚠️ No live price available (feed stale/quiet) — entry below is the unverified theoretical breakout level (${revision.theoreticalEntry.toFixed(2)}). Verify the real price manually before acting.`
    : Math.abs(revision.driftPct) >= 0.05
      ? `⚠️ Price moved ${revision.driftPct >= 0 ? '+' : ''}${revision.driftPct.toFixed(2)}% from the breakout level (${revision.theoreticalEntry.toFixed(2)}) before this alert sent — entry/stop below are revised to real price.`
      : `Breakout level: ${revision.theoreticalEntry.toFixed(2)} (verified — negligible drift, entry matches closely)`;
  const stopLine = revision.usedFallbackStop
    ? `Stop-loss: ${revision.stop.toFixed(2)} (structural stop too wide after drift — using 2% cap instead)`
    : `Stop-loss: ${revision.stop.toFixed(2)} (structural, opposite side of opening range)`;
  const vs = e.direction === 'LONG' ? 'above' : 'below';
  const confirmLine = `Confirmed: ${vs} VWAP (${e.vwap.toFixed(2)}) and ${vs} 20 SMA / Bollinger middle band (${e.bbMiddle.toFixed(2)})`;
  return [
    '[ORB STRATEGY] New position entered',
    `Stock: ${e.symbol}`,
    `Direction: ${e.direction}`,
    driftLine,
    `Entry: ${revision.entry.toFixed(2)}`,
    stopLine,
    'Target: dynamic — no fixed target, trails via Bollinger Band hugging exit',
    confirmLine,
    `Breakout volume: ${e.volumeRatio.toFixed(1)}x opening-range average`,
    obLine,
    '(Intraday, squares off by close. Alert only — no order placed.)',
  ].join('\n');
}

function formatExitAlert(e, revision) {
  const pnlStr = (revision.pnlPct >= 0 ? '+' : '') + revision.pnlPct.toFixed(2) + '%';
  return [
    '[ORB STRATEGY] Position closed',
    `Stock: ${e.symbol}`,
    `Direction: ${e.direction}`,
    `Entry: ${revision.entry.toFixed(2)}`,
    `Exit: ${revision.exitPrice.toFixed(2)} (${e.action}, real price at detection — not the stale trigger level)`,
    `Stop-loss was: ${e.stop.toFixed(2)}`,
    `P&L: ${pnlStr}`,
  ].join('\n');
}

function getOrCreateTracker(symbol) {
  if (!trackers[symbol]) trackers[symbol] = new ORBSymbolTracker(symbol);
  return trackers[symbol];
}

function handleBar(symbol, bar) {
  const tracker = getOrCreateTracker(symbol);
  const events = tracker.onNewBar(bar);
  for (const e of events) {
    if (e.type === 'ENTRY') {
      const revision = reviseEntryForLiveExecution(e, tickBuilders[symbol]);
      revisedPositions[symbol] = { entry: revision.entry, stop: revision.stop, direction: e.direction };
      sendTelegramAlert(formatEntryAlert(e, revision));
    } else if (e.type === 'EXIT') {
      const revision = reviseExitForLiveExecution(e, tickBuilders[symbol], revisedPositions[symbol]);
      sendTelegramAlert(formatExitAlert(e, revision));
      recordTrade({ ...e, entry: revision.entry, exitPrice: revision.exitPrice, pnlPct: revision.pnlPct });
      delete revisedPositions[symbol];
    }
  }
}

/**
 * Force-closes any forming bar whose minute has fully elapsed with no new
 * tick since — needed because onTick() only closes a bar when a tick from
 * the NEXT minute arrives. Without this, the last bar of the day (and any
 * bar for an illiquid stock that goes quiet) would never close and never
 * reach the ORB tracker.
 */
function scheduleBarFlush() {
  setInterval(() => {
    const now = Date.now();
    for (const [symbol, builder] of Object.entries(tickBuilders)) {
      const bar = builder.flushIfStale(now);
      if (bar) handleBar(symbol, bar);
    }
  }, FLUSH_POLL_MS);
}

/**
 * Checks once per poll whether it's past today's push window and hasn't
 * pushed yet — fires the trade log push once/day, well after the 15:30
 * EOD square-off, never mid-session (see trade_log.js for why).
 */
function scheduleDailyTradeLogPush() {
  let lastPushDate = null;
  setInterval(() => {
    const { minutesOfDay, dateStr } = istMinutesAndDate();
    if (minutesOfDay >= TRADE_LOG_PUSH_AFTER_MIN && lastPushDate !== dateStr) {
      lastPushDate = dateStr;
      pushTradeLogToGitHub(dateStr).catch((e) => console.error('Trade log push threw:', e.message));
    }
  }, TRADE_LOG_POLL_MS);
}

/**
 * Connects, subscribes, and streams until the WebSocket closes or errors.
 * Resolves (not rejects) when the connection ends, matching the ema-scalp
 * live streamer's resilience convention — a stale token or transient drop
 * should never crash the process on a long-running host like Railway.
 */
function connectAndRun() {
  return new Promise(async (resolve) => {
    let wsUrl;
    try {
      wsUrl = await getMarketFeedUrl();
    } catch (e) {
      console.error('Could not get market feed URL (likely an expired/missing token):', e.message);
      resolve({ reason: 'auth_failed' });
      return;
    }

    console.log('Connecting to Upstox live feed...');
    const ws = new WebSocket(wsUrl, { followRedirects: true });

    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      resolve({ reason });
    };

    ws.on('open', () => {
      console.log('Connected. Subscribing to', Object.keys(symbolMap).length, 'stocks...');
      setTimeout(() => {
        const instrumentKeys = Object.values(symbolMap);
        ws.send(Buffer.from(JSON.stringify({
          guid: 'orb-live',
          method: 'sub',
          data: { mode: 'full', instrumentKeys },
        })));
        console.log('Subscription sent.');
      }, 1000);
    });

    ws.on('message', (data) => {
      let decoded;
      try {
        decoded = decodeProtobuf(data);
      } catch (e) {
        console.warn('Protobuf decode error:', e.message);
        return;
      }
      if (!decoded || !decoded.feeds) return;

      for (const [instrumentKey, feed] of Object.entries(decoded.feeds)) {
        const symbol = keyToSymbol[instrumentKey];
        if (!symbol) continue;
        const tick = extractTick(feed);
        if (!tick) continue;
        const closedBar = getOrCreateTickBuilder(symbol).onTick(tick);
        if (closedBar) handleBar(symbol, closedBar);
      }
    });

    ws.on('close', () => {
      console.log('Disconnected from feed.');
      finish('closed');
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
      finish('error');
    });

    process.once('SIGTERM', () => finish('sigterm'));
    process.once('SIGINT', () => finish('sigint'));
  });
}

/**
 * Outer retry loop with exponential backoff (capped at 5 min) — same
 * resilience pattern as the EMA scalp live streamer. Upstox's feed has
 * documented, widely-reported reliability issues independent of this
 * project's code (see chat history for the community-forum evidence) —
 * this loop is the correct mitigation, not a workaround for a bug here.
 */
async function main() {
  console.log('Initializing protobuf schema...');
  await initProtobuf();
  await syncTradeLogFromRemote();
  scheduleDailyTradeLogPush();
  scheduleBarFlush();

  let attempt = 0;
  for (;;) {
    const { reason } = await connectAndRun();
    if (reason === 'sigterm' || reason === 'sigint') {
      console.log('Shutting down (', reason, ').');
      process.exit(0);
    }
    attempt++;
    const delayMs = Math.min(30000 * attempt, 300000);
    console.log(`Connection ended (${reason}). Retrying in ${delayMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
