'use strict';

/**
 * Live intraday streamer for the EMA scalp strategy (SHORT+BIG_BAR+14:30
 * cutoff, the same validated rules as the backtest and shadow-trade
 * scripts). Connects to Upstox's official V3 market-data WebSocket feed,
 * decodes 1-minute OHLC candles via Protobuf, aggregates them into 5-min
 * bars per symbol, and runs the SAME signal logic used everywhere else in
 * this project (findDaySignalShortBigBarOnly, unmodified) incrementally as
 * each bar completes. Alerts fire the moment a signal or outcome resolves
 * — genuinely real-time, not after-the-fact like shadow_trade_daily.js.
 *
 * No live orders placed. Alert-only.
 *
 * Requires UPSTOX_ACCESS_TOKEN and TELEGRAM_BOT_TOKEN env vars (same
 * daily-refreshed token your live announcement bot already uses for the
 * first one; same bot token already in use for Telegram alerts).
 *
 * Known caveat: Upstox's community forum has reported I1 (1-min) candle
 * accuracy issues specifically at market open (9:15 IST) in the V3 feed.
 * Low practical impact here since the strategy needs 20 bars of EMA
 * warmup before any signal can fire, but worth knowing about.
 */

const WebSocket = require('ws');
const protobuf = require('protobufjs');
const fs = require('fs');
const path = require('path');

const { BarAggregator } = require('./bar_aggregator');
const { LiveSymbolTracker } = require('./live_signal_engine');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046'];
const NIFTY_KEY = 'NSE_INDEX|Nifty 50';
const LOG_PATH = path.join(__dirname, 'live_trades_log.json');
const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';

if (!UPSTOX_TOKEN) {
  console.error('FATAL: UPSTOX_ACCESS_TOKEN env var not set. Cannot start.');
  process.exit(1);
}
if (!TELEGRAM_TOKEN) {
  console.warn('WARNING: TELEGRAM_BOT_TOKEN not set. Alerts will be logged but not sent.');
}

const symbolMap = require('../symbols.json');
const keyToSymbol = {};
for (const [symbol, key] of Object.entries(symbolMap)) keyToSymbol[key] = symbol;

let protobufRoot = null;
let niftyCandles5m = [];
const barAggregators = {}; // symbol -> BarAggregator
const trackers = {}; // symbol -> LiveSymbolTracker

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
  // Explicit conversion (not implicit Long coercion) for int64 fields like ts/vol.
  return FeedResponse.toObject(message, { longs: Number, enums: String, defaults: true });
}

/** Extracts 1-min ("I1") OHLC entries from a decoded Feed message, for either equity (marketFF) or index (indexFF) feeds. */
function extractOneMinCandles(feed) {
  const fullFeed = feed.fullFeed;
  if (!fullFeed) return [];
  const inner = fullFeed.marketFF || fullFeed.indexFF;
  if (!inner || !inner.marketOHLC || !inner.marketOHLC.ohlc) return [];
  return inner.marketOHLC.ohlc
    .filter((o) => o.interval === 'I1')
    .map((o) => ({
      timestampMs: Number(o.ts),
      open: o.open, high: o.high, low: o.low, close: o.close, volume: Number(o.vol || 0),
    }));
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

function formatSignalAlert(e) {
  return [
    '[EMA SCALP LIVE] Signal just fired',
    `Stock: ${e.symbol}`,
    `Direction: ${e.direction}`,
    `Entry: ${e.entryPrice}`,
    `Stop-loss: ${e.stopLoss}`,
    `Target: ${e.target}`,
    '(Paper/alert only — no real order placed. Outcome not yet known.)',
  ].join('\n');
}

function formatOutcomeAlert(e) {
  return [
    '[EMA SCALP LIVE] Trade resolved',
    `Stock: ${e.symbol}`,
    `Result: ${e.action} @ ${e.exitPrice.toFixed(2)}`,
    `Gross P&L: ${e.pnlPct >= 0 ? '+' : ''}${e.pnlPct.toFixed(3)}%`,
    `Net P&L (after costs): ${e.netPnlPct >= 0 ? '+' : ''}${e.netPnlPct.toFixed(3)}%`,
    `Held ${e.barsHeld} bar(s) (~${e.barsHeld * 5} min)`,
  ].join('\n');
}

function appendToLog(entry) {
  let log = [];
  if (fs.existsSync(LOG_PATH)) log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  log.push({ ...entry, loggedAt: new Date().toISOString() });
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
}

function getOrCreateTracker(symbol) {
  if (!trackers[symbol]) trackers[symbol] = new LiveSymbolTracker(symbol, () => niftyCandles5m);
  return trackers[symbol];
}

function handleBar(symbol, bar) {
  const tracker = getOrCreateTracker(symbol);
  const events = tracker.onNewBar(bar);
  for (const e of events) {
    if (e.type === 'SIGNAL') {
      sendTelegramAlert(formatSignalAlert(e));
    } else if (e.type === 'OUTCOME') {
      sendTelegramAlert(formatOutcomeAlert(e));
      appendToLog({ symbol: e.symbol, ...e.signal, action: e.action, exitPrice: e.exitPrice, barsHeld: e.barsHeld, pnlPct: e.pnlPct, costPct: e.costPct, netPnlPct: e.netPnlPct });
    }
  }
}

/**
 * Connects, subscribes, and streams until the WebSocket closes or errors.
 * Resolves (not rejects) when the connection ends, so the caller can decide
 * whether/how to retry — a stale token or a transient drop should never
 * crash the process on a long-running host like Railway.
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

    const niftyAgg = new BarAggregator((bar) => { niftyCandles5m.push(bar); });
    barAggregators[NIFTY_KEY] = niftyAgg;

    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      resolve({ reason });
    };

    ws.on('open', () => {
      console.log('Connected. Subscribing to', Object.keys(symbolMap).length, 'stocks + Nifty 50...');
      setTimeout(() => {
        const instrumentKeys = [NIFTY_KEY, ...Object.values(symbolMap)];
        ws.send(Buffer.from(JSON.stringify({
          guid: 'ema-scalp-live',
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
        const oneMinCandles = extractOneMinCandles(feed);
        if (oneMinCandles.length === 0) continue;

        if (instrumentKey === NIFTY_KEY) {
          for (const c of oneMinCandles) niftyAgg.push(c);
          continue;
        }

        const symbol = keyToSymbol[instrumentKey];
        if (!symbol) continue;

        if (!barAggregators[symbol]) {
          barAggregators[symbol] = new BarAggregator((bar) => handleBar(symbol, bar));
        }
        for (const c of oneMinCandles) barAggregators[symbol].push(c);
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

    process.once('SIGTERM', () => { finalizeDay(ws); finish('sigterm'); });
    process.once('SIGINT', () => { finalizeDay(ws); finish('sigint'); });
  });
}

/**
 * Outer retry loop with exponential backoff (capped at 5 min). Keeps the
 * process alive indefinitely rather than crash-exiting — expected to spend
 * most of its time retrying harmlessly before market open / after an
 * expired token, until a fresh UPSTOX_ACCESS_TOKEN is set and it connects.
 */
async function main() {
  console.log('Initializing protobuf schema...');
  await initProtobuf();

  let attempt = 0;
  for (;;) {
    const { reason } = await connectAndRun();
    if (reason === 'sigterm' || reason === 'sigint') {
      console.log('Shutting down (', reason, ').');
      process.exit(0);
    }
    attempt++;
    const delayMs = Math.min(30000 * attempt, 300000); // 30s, 60s, ... capped at 5 min
    console.log(`Connection ended (${reason}). Retrying in ${delayMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

function finalizeDay(ws) {
  console.log('Finalizing day...');
  for (const symbol of Object.keys(barAggregators)) {
    barAggregators[symbol].flushRemaining();
  }
  for (const [symbol, tracker] of Object.entries(trackers)) {
    const events = tracker.forceEndOfDay();
    for (const e of events) {
      if (e.type === 'OUTCOME') {
        sendTelegramAlert(formatOutcomeAlert(e));
        appendToLog({ symbol: e.symbol, ...e.signal, action: e.action, exitPrice: e.exitPrice, barsHeld: e.barsHeld, pnlPct: e.pnlPct, costPct: e.costPct, netPnlPct: e.netPnlPct });
      }
    }
  }
  try { ws.close(); } catch (e) { /* already closed */ }
  // Exit is handled by main()'s retry loop after connectAndRun() resolves with reason 'sigterm'/'sigint'.
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
