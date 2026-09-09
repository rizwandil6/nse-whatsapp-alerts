'use strict';

/**
 * Sabbal Stick (Qutub Minar) 15-min signal monitor -- fully self-contained,
 * fully independent of the DarvasBox tick-WebSocket pipeline above it in
 * this same process. On purpose: this uses Upstox's PUBLIC historical/
 * intraday candle REST endpoints (no UPSTOX_ACCESS_TOKEN needed -- see
 * wiki/reference/upstox-api.md in the vault), polled on a plain interval,
 * so a bug or an HTTP hiccup here can never touch the WebSocket tick
 * handling, EMA tracking, or trade state that DarvasBox depends on. Started
 * from streamer.js as a fire-and-forget setInterval with its own top-level
 * try/catch per cycle -- an uncaught error here logs and skips a cycle, it
 * does not crash the process.
 *
 * Rules (from the "Sabbal Stick" strategy, see the vault's
 * wiki/concepts/sabbal-stick-strategy.md): a run of >=2 consecutive same-
 * color 15-min candles ("Qutub Minar" for green / mirrored for red),
 * followed by an opposite-color reversal candle that (a) is not a doji,
 * (b) covers >=50% of the prior candle's body or fully engulfs it, and
 * (c) has volume >= 1.2x its own recent 15-min average. SELL HIGH -> SHORT
 * entry; BUY LOW -> LONG entry. Hard exit: 0.5% target, stop-loss = the
 * entry candle's own low (LONG) / high (SHORT) -- both fixed at entry time,
 * per the user's explicit instruction, not the author's (unspecified by
 * the source).
 *
 * This alerts only. It never places, modifies, or cancels a real order.
 */

const https = require('https');

const SYMBOLS = {
  RVNL: 'NSE_EQ|INE415G01027',
  WAAREEENER: 'NSE_EQ|INE377N01017',
  SUZLON: 'NSE_EQ|INE040H01021',
};

const RUN_LEN_MIN = 2;          // user-specified (default was 3, loosened to 2)
const DOJI_BODY_PCT = 15;       // body as % of range below this = doji, skip
const REVERSAL_PCT = 50;        // 50% rule
const VOL_STRONG_MULT = 1.2;
const VOL_AVG_LOOKBACK = 20;
const VOL_MIN_HISTORY = 5;      // below this, skip the volume gate (insufficient data), don't block the signal
const TARGET_PCT = 0.005;       // 0.5%
const POLL_INTERVAL_MS = 60 * 1000;
const BUCKET_MIN = 15;

const TELEGRAM_TOKEN = process.env.SABBAL_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = (process.env.SABBAL_TELEGRAM_CHAT_IDS || '5937539323').split(',');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': UA } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

async function fetchIntraday1min(instrumentKey) {
  const enc = encodeURIComponent(instrumentKey);
  const url = `https://api.upstox.com/v3/historical-candle/intraday/${enc}/minutes/1`;
  const data = await httpGetJson(url);
  const candles = (data && data.data && data.data.candles) || [];
  // Upstox returns newest-first: [ts, open, high, low, close, volume, oi]
  return candles
    .map((c) => ({ ts: new Date(c[0]), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.ts - b.ts); // oldest-first
}

/** Aggregate 1-min bars into 15-min buckets, keeping only FULLY ELAPSED buckets. */
function aggregateTo15min(oneMinBars) {
  if (!oneMinBars.length) return [];
  const buckets = new Map();
  for (const bar of oneMinBars) {
    const istMinutesOfDay = bar.ts.getUTCHours() * 60 + bar.ts.getUTCMinutes() + 330; // UTC->IST offset
    const bucketStartMin = Math.floor(istMinutesOfDay / BUCKET_MIN) * BUCKET_MIN;
    const key = bucketStartMin;
    if (!buckets.has(key)) {
      buckets.set(key, { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0, count: 0, bucketStartMin });
    }
    const b = buckets.get(key);
    b.high = Math.max(b.high, bar.high);
    b.low = Math.min(b.low, bar.low);
    b.close = bar.close;
    b.volume += bar.volume;
    b.count += 1;
  }
  const lastBarMinOfDay = (() => {
    const t = oneMinBars[oneMinBars.length - 1].ts;
    return t.getUTCHours() * 60 + t.getUTCMinutes() + 330;
  })();
  const out = [];
  for (const b of [...buckets.values()].sort((x, y) => x.bucketStartMin - y.bucketStartMin)) {
    const bucketEndMin = b.bucketStartMin + BUCKET_MIN;
    // only keep buckets whose window has fully elapsed (last available 1-min bar is at/after bucket end - 1min)
    if (lastBarMinOfDay >= bucketEndMin - 1) {
      out.push(b);
    }
  }
  return out;
}

function bodyOf(bar) { return Math.abs(bar.close - bar.open); }
function rangeOf(bar) { return bar.high - bar.low; }
function isGreen(bar) { return bar.close > bar.open; }
function isRed(bar) { return bar.close < bar.open; }
function isDoji(bar) {
  const r = rangeOf(bar);
  if (r === 0) return true;
  return (bodyOf(bar) / r) * 100 <= DOJI_BODY_PCT;
}

function volStrongEnough(bars, idx) {
  const start = Math.max(0, idx - VOL_AVG_LOOKBACK);
  const history = bars.slice(start, idx); // excludes current bar
  if (history.length < VOL_MIN_HISTORY) return { ok: true, note: 'vol-check skipped (insufficient history)' };
  const avg = history.reduce((s, b) => s + b.volume, 0) / history.length;
  const ok = bars[idx].volume >= avg * VOL_STRONG_MULT;
  return { ok, note: ok ? null : `volume ${bars[idx].volume} < ${VOL_STRONG_MULT}x avg(${avg.toFixed(0)})` };
}

/** Evaluate the LAST bar in `bars` (oldest-first) for a SELL or BUY signal. Returns null or {direction, entryPx, slPx, targetPx, note}. */
function evaluateSignal(bars) {
  const idx = bars.length - 1;
  if (idx < RUN_LEN_MIN) return null;
  const cur = bars[idx];
  if (isDoji(cur)) return null;

  const vol = volStrongEnough(bars, idx);
  if (!vol.ok) return null;

  // Check for a >=RUN_LEN_MIN run of the OPPOSITE color ending at idx-1
  function runLenBefore(colorFn) {
    let n = 0;
    for (let i = idx - 1; i >= 0 && colorFn(bars[i]); i--) n++;
    return n;
  }

  if (isRed(cur)) {
    const greenRun = runLenBefore(isGreen);
    if (greenRun < RUN_LEN_MIN) return null;
    const prevGreen = bars[idx - 1];
    const prevBody = bodyOf(prevGreen);
    const coversPct = prevBody === 0 ? 0 : (bodyOf(cur) / prevBody) * 100;
    const engulfs = cur.close < prevGreen.open;
    if (!(coversPct >= REVERSAL_PCT || engulfs)) return null;
    const entryPx = cur.close;
    const slPx = cur.high;
    const targetPx = entryPx * (1 - TARGET_PCT);
    return { direction: 'SHORT', entryPx, slPx, targetPx, note: vol.note };
  }

  if (isGreen(cur)) {
    const redRun = runLenBefore(isRed);
    if (redRun < RUN_LEN_MIN) return null;
    const prevRed = bars[idx - 1];
    const prevBody = bodyOf(prevRed);
    const coversPct = prevBody === 0 ? 0 : (bodyOf(cur) / prevBody) * 100;
    const engulfs = cur.close > prevRed.open;
    if (!(coversPct >= REVERSAL_PCT || engulfs)) return null;
    const entryPx = cur.close;
    const slPx = cur.low;
    const targetPx = entryPx * (1 + TARGET_PCT);
    return { direction: 'LONG', entryPx, slPx, targetPx, note: vol.note };
  }

  return null;
}

/** Check whether the LAST bar closes the given open position (target or SL). Conservative: SL wins on same-bar overlap unless price gapped through target at the open. */
function checkExit(position, bar) {
  const { direction, slPx, targetPx } = position;
  if (direction === 'LONG') {
    const hitSl = bar.low <= slPx;
    const hitTarget = bar.high >= targetPx;
    if (hitSl && hitTarget) {
      if (bar.open >= targetPx) return { exitPx: targetPx, reason: 'TARGET_0.5PCT' };
      return { exitPx: slPx, reason: 'STOPLOSS' };
    }
    if (hitSl) return { exitPx: slPx, reason: 'STOPLOSS' };
    if (hitTarget) return { exitPx: targetPx, reason: 'TARGET_0.5PCT' };
    return null;
  }
  // SHORT
  const hitSl = bar.high >= slPx;
  const hitTarget = bar.low <= targetPx;
  if (hitSl && hitTarget) {
    if (bar.open <= targetPx) return { exitPx: targetPx, reason: 'TARGET_0.5PCT' };
    return { exitPx: slPx, reason: 'STOPLOSS' };
  }
  if (hitSl) return { exitPx: slPx, reason: 'STOPLOSS' };
  if (hitTarget) return { exitPx: targetPx, reason: 'TARGET_0.5PCT' };
  return null;
}

async function sendSabbalTelegramAlert(text) {
  console.log('[SABBAL]', text.replace(/\n/g, ' | '));
  if (!TELEGRAM_TOKEN) return;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      await new Promise((resolve, reject) => {
        const payload = JSON.stringify({ chat_id: chatId, text });
        const req = https.request(
          `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
          { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
          (res) => { res.on('data', () => {}); res.on('end', resolve); }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    } catch (e) {
      console.error(`[SABBAL] Telegram send failed for chat ${chatId}:`, e.message);
    }
  }
}

function nowIst() {
  const now = new Date();
  const istMs = now.getTime() + (330 + now.getTimezoneOffset()) * 60000;
  return new Date(istMs);
}

function isMarketWindow(ist) {
  const day = ist.getDay(); // 0 Sun .. 6 Sat (evaluated against the IST-shifted Date, safe since we only read day/hour/min)
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

/** New entries only 9:15-15:00 IST -- after 3pm, keep managing any open position through to its exit but stop looking for fresh signals (user instruction, 2026-09-09). */
function newEntriesAllowed(ist) {
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 15 && mins < 15 * 60;
}

/** Only run a cycle in the few minutes right after a 15-min boundary, so we react to a freshly-closed bar without hammering the API every minute all day. */
function justAfterBoundary(ist) {
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const rem = mins % BUCKET_MIN;
  return rem >= 1 && rem <= 3;
}

function startSabbalStickMonitor({ sabbalDb } = {}) {
  const lastProcessedBucket = {}; // symbol -> bucketStartMin already acted on
  const openPositions = {};       // symbol -> position | undefined

  async function warmStart() {
    if (!sabbalDb) return;
    try {
      await sabbalDb.ensureSchema();
      const restored = await sabbalDb.loadOpenPositions();
      for (const [sym, pos] of Object.entries(restored)) {
        openPositions[sym] = { direction: pos.direction, entryPx: pos.entryPx, slPx: pos.slPx, targetPx: pos.targetPx, entryTs: pos.entryTs };
        console.log(`[SABBAL] Restored open ${pos.direction} position on ${sym} from Postgres (entry ₹${pos.entryPx}).`);
      }
    } catch (e) {
      console.error('[SABBAL] warmStart failed (continuing without restored state):', e.message);
    }
  }

  async function runCycle() {
    const ist = nowIst();
    if (!isMarketWindow(ist)) return;
    if (!justAfterBoundary(ist)) return;

    for (const [symbol, key] of Object.entries(SYMBOLS)) {
      try {
        const oneMin = await fetchIntraday1min(key);
        const bars = aggregateTo15min(oneMin);
        if (!bars.length) continue;
        const lastBucket = bars[bars.length - 1].bucketStartMin;
        if (lastProcessedBucket[symbol] === lastBucket) continue; // already handled this bar
        lastProcessedBucket[symbol] = lastBucket;

        const lastBar = bars[bars.length - 1];
        const open = openPositions[symbol];

        if (open) {
          const exit = checkExit(open, lastBar);
          if (exit) {
            const pnlPct = open.direction === 'LONG'
              ? ((exit.exitPx - open.entryPx) / open.entryPx) * 100
              : ((open.entryPx - exit.exitPx) / open.entryPx) * 100;
            const sign = pnlPct >= 0 ? '+' : '';
            await sendSabbalTelegramAlert(
              `Sabbal Stick — EXIT (${exit.reason})\n${symbol} ${open.direction}\nEntry: ₹${open.entryPx.toFixed(2)} -> Exit: ₹${exit.exitPx.toFixed(2)}\nP&L: ${sign}${pnlPct.toFixed(2)}% (gross, no costs)`
            );
            if (sabbalDb) {
              await sabbalDb.recordExit({
                symbol, direction: open.direction, entryTs: open.entryTs, entryPx: open.entryPx,
                slPx: open.slPx, targetPx: open.targetPx, exitTs: new Date(), exitPx: exit.exitPx,
                exitReason: exit.reason, pnlPct, tradeDate: ist.toISOString().slice(0, 10),
              });
            }
            delete openPositions[symbol];
          }
          continue; // one position at a time per symbol -- don't also evaluate a fresh entry same cycle
        }

        if (!newEntriesAllowed(ist)) continue; // past 3pm: manage open positions only, no new entries

        const signal = evaluateSignal(bars);
        if (signal) {
          const entryTs = new Date();
          openPositions[symbol] = { ...signal, entryTs };
          const noteLine = signal.note ? `\n(${signal.note})` : '';
          await sendSabbalTelegramAlert(
            `Sabbal Stick — ENTRY\n${symbol} ${signal.direction}\nEntry: ₹${signal.entryPx.toFixed(2)}\nStop-loss: ₹${signal.slPx.toFixed(2)}\nTarget (0.5%): ₹${signal.targetPx.toFixed(2)}${noteLine}`
          );
          if (sabbalDb) {
            await sabbalDb.recordEntry({
              symbol, direction: signal.direction, entryTs, entryPx: signal.entryPx,
              slPx: signal.slPx, targetPx: signal.targetPx, tradeDate: ist.toISOString().slice(0, 10),
            });
          }
        }
      } catch (e) {
        console.error(`[SABBAL] cycle error for ${symbol}:`, e.message);
      }
    }
  }

  warmStart().finally(() => {
    console.log('[SABBAL] Sabbal Stick 15-min monitor started (RVNL, WAAREEENER, SUZLON).');
    setInterval(() => { runCycle().catch((e) => console.error('[SABBAL] runCycle threw:', e.message)); }, POLL_INTERVAL_MS);
  });
}

module.exports = { startSabbalStickMonitor, evaluateSignal, aggregateTo15min, checkExit };
