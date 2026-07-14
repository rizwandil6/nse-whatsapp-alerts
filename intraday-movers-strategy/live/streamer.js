'use strict';

/**
 * Live intraday streamer for the Opening Range Breakout strategy (30x
 * volume confirmation, 2% target, 2% structural stop cap — the same
 * validated settings as the backtest). Connects to Upstox's official V3
 * market-data WebSocket feed, decodes 1-minute OHLC candles via Protobuf,
 * and feeds them directly (no 5-min aggregation — ORB needs raw 1-min bars,
 * matching the backtest) into one ORBSymbolTracker per stock.
 *
 * No live orders placed. Alert-only.
 *
 * Requires UPSTOX_ACCESS_TOKEN and TELEGRAM_BOT_TOKEN env vars.
 */

const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('path');

const { ORBSymbolTracker } = require('./orb_engine');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046'];
const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';

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

let protobufRoot = null;
const trackers = {}; // symbol -> ORBSymbolTracker

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

function extractOneMinCandles(feed) {
  const fullFeed = feed.fullFeed;
  if (!fullFeed) return [];
  const inner = fullFeed.marketFF || fullFeed.indexFF;
  if (!inner || !inner.marketOHLC || !inner.marketOHLC.ohlc) return [];
  // tbq/tsq (total buy/sell quantity resting in the order book) is a
  // snapshot at message-arrival time, not a per-candle aggregate — only
  // present on marketFF (equities), not indexFF. Logged alongside each
  // candle as an order-flow-direction signal to evaluate, not yet used to
  // gate entries — see orb_engine.js.
  const tbq = fullFeed.marketFF ? fullFeed.marketFF.tbq : null;
  const tsq = fullFeed.marketFF ? fullFeed.marketFF.tsq : null;
  return inner.marketOHLC.ohlc
    .filter((o) => o.interval === 'I1')
    .map((o) => ({
      timestampMs: Number(o.ts),
      open: o.open, high: o.high, low: o.low, close: o.close, volume: Number(o.vol || 0),
      tbq, tsq,
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

function formatEntryAlert(e) {
  const obLine =
    e.obImbalance != null
      ? `Order book: TBQ ${e.tbq} / TSQ ${e.tsq} (${(e.obImbalance * 100).toFixed(0)}% buy-side) — logged only, not used for entry`
      : 'Order book: n/a';
  return [
    '[ORB STRATEGY] New position entered',
    `Stock: ${e.symbol}`,
    `Direction: ${e.direction}`,
    `Entry: ${e.entry.toFixed(2)}`,
    `Stop-loss: ${e.stop.toFixed(2)}`,
    `Target: ${e.target.toFixed(2)}`,
    `Breakout volume: ${e.volumeRatio.toFixed(1)}x opening-range average`,
    obLine,
    '(Intraday, squares off by close. Alert only — no order placed.)',
  ].join('\n');
}

function formatExitAlert(e) {
  const pnlStr = (e.pnlPct >= 0 ? '+' : '') + e.pnlPct.toFixed(2) + '%';
  return [
    '[ORB STRATEGY] Position closed',
    `Stock: ${e.symbol}`,
    `Direction: ${e.direction}`,
    `Entry: ${e.entry.toFixed(2)}`,
    `Exit: ${e.exitPrice.toFixed(2)} (${e.action})`,
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
    if (e.type === 'ENTRY') sendTelegramAlert(formatEntryAlert(e));
    else if (e.type === 'EXIT') sendTelegramAlert(formatExitAlert(e));
  }
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
        const oneMinCandles = extractOneMinCandles(feed);
        for (const c of oneMinCandles) handleBar(symbol, c);
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
