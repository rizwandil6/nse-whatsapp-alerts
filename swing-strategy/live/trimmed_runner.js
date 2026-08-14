'use strict';

/**
 * Trimmed Confluence Swing Strategy — daily forward-tracking runner.
 *
 * This is the "this session's rules" variant (validated in the vault
 * forward_scan.py, which is the reference spec): the FULL course confluence
 * minus the RSI gate. A signal fires when ALL of:
 *   1. price is at a fresh, recently-touched, uninvalidated DAILY demand zone
 *      (reuses zones.recentlyTouchedUninvalidatedZones)
 *   2. WEEKLY 50-SMA is rising (>= 5 weeks ago) AND price is above it
 *   3. DAILY 9-EMA crosses above 20-SMA that bar AND volume > 1.2x its 20d avg
 * RSI (>=55 on D/W/M) is recorded as `rsiGatePass` but does NOT gate.
 *
 * Entry = next session's open. Stop = zone distal - 0.25*ATR(14). Exit = book
 * half at +2R, then trail the remainder under the 20-EMA. Costs 0.25% round-trip.
 *
 * Stateless: recomputes pending/open/closed from history every run (same design
 * as the course runner.js) and upserts each into swing.signals. Only daily
 * candles are fetched; weekly/monthly are resampled locally (W-FRI / calendar
 * month) to match the Python reference exactly. Data is public — no token needed.
 */

const { sma, ema, rsi, isSmaRising, isGoldenCross } = require('./indicators');
const { recentlyTouchedUninvalidatedZones } = require('./zones');
const { SwingDB } = require('./swing_db');
const { computeRsRawSeries, percentileRankByDate, buildDateIndexMap } = require('./rs_rank');

const symbolMap = require('./symbols.json');

const COST = 0.0025;
const SIGNAL_LOOKBACK = 130;   // daily bars back to scan for fired signals (> ~90d hold)
const FETCH_YEARS = 3;
const FETCH_DELAY_MS = 100;    // polite, sequential
const UPSTOX_BASE = 'https://api.upstox.com/v2';
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || 'public'; // candle endpoints are public

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d = 2) => (x == null || Number.isNaN(x) ? null : Number(x.toFixed(d)));

// rsRankAtEntry (2026-08-14, upgraded from reading rs-momentum-strategy's published
// snapshot): computed SAME-DAY from this run's own fetched data using the local
// rs_rank.js copy, instead of that published file -- which lags a day given the
// two services' run-order (this runner fires 19:00-19:10 IST, rs-momentum-strategy's
// own rank job runs LATER, 20:00-20:30 IST, so at read time its "today" snapshot was
// actually still yesterday's). Cross-sectional percentile ranking needs EVERY
// symbol's RS_raw before any one symbol's rank is known, so this can't be folded
// into the main per-symbol loop below -- see the two-pass structure in runOnce().
// FETCH_YEARS (3) already comfortably covers the 12mo lookback this needs; the only
// new network cost is the one extra Nifty 50 fetch.
function computeTodayRsRanks(dailyBySymbol, nifty, today) {
  const niftyDateMap = buildDateIndexMap(nifty);
  const rsRawBySymbolByDate = {};
  for (const [symbol, daily] of Object.entries(dailyBySymbol)) {
    const series = computeRsRawSeries(daily, nifty, niftyDateMap);
    const last = series[series.length - 1];
    if (last != null) rsRawBySymbolByDate[symbol] = { [today]: last };
  }
  const ranked = percentileRankByDate(rsRawBySymbolByDate);
  const map = new Map();
  for (const [symbol, byDate] of Object.entries(ranked)) {
    if (byDate[today] != null) map.set(symbol, byDate[today]);
  }
  return map;
}

// --- alerting (same pattern as ./runner.js's sendTelegramAlert) -------------
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
function formatNewSignalAlert(r) {
  return ['[SWING STRATEGY] New signal — plan entry for tomorrow\'s open', `Stock: ${r.symbol}`,
    `Signal date: ${r.signalDate}`, `Stop-loss: ${r.stopPx}`, `Full-spec (RSI gate)? ${r.rsiGatePass ? 'yes' : 'no'}`].join('\n');
}
function formatHalfBookAlert(r) {
  return ['[SWING STRATEGY] Booked half at +2R — trail the remainder', `Stock: ${r.symbol}`,
    `Half-book price: ${r.halfPrice} (on ${r.halfDate})`, `Entry was: ${r.entryPx}`].join('\n');
}
function formatExitAlert(r) {
  const pnlStr = (r.sinceAlertPct >= 0 ? '+' : '') + r.sinceAlertPct.toFixed(2) + '%';
  return ['[SWING STRATEGY] Position closed', `Stock: ${r.symbol}`, `Entry: ${r.entryPx}`,
    `Exit: ${r.exitPx} (${r.rNet >= 0 ? 'trailed after +2R' : 'stopped out'})`,
    `P&L: ${pnlStr} · ${r.rNet.toFixed(2)}R net`].join('\n');
}

function istDateStr(ms = Date.now()) {
  return new Date(ms + (5 * 60 + 30) * 60000).toISOString().slice(0, 10);
}
function dateRange(years) {
  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - years);
  return { from: to.toISOString().slice(0, 10), fromDate: from.toISOString().slice(0, 10) };
}

// --- fetch (public) ---------------------------------------------------------
async function fetchDaily(instrumentKey) {
  const { from, fromDate } = dateRange(FETCH_YEARS);
  const url = `${UPSTOX_BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/day/${from}/${fromDate}`;
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
      const body = await res.json();
      if (body?.status === 'success') {
        return (body.data.candles || [])
          .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
          .sort((x, y) => x.timestampMs - y.timestampMs);
      }
    } catch (_) { /* 429 / non-JSON -> back off */ }
    await sleep(Math.min(1000 * 2 ** a, 15000));
  }
  return null;
}

/** Today's daily bar, synthesized from the intraday endpoint, when the official daily bar hasn't posted yet. */
async function fetchTodayBar(instrumentKey) {
  const url = `${UPSTOX_BASE}/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/1minute`;
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
      const body = await res.json();
      if (body?.status === 'success') {
        const c = body.data.candles || [];
        if (!c.length) return null;
        // candles are newest-first
        const open = c[c.length - 1][1];
        const close = c[0][4];
        const high = Math.max(...c.map((r) => r[2]));
        const low = Math.min(...c.map((r) => r[3]));
        const volume = c.reduce((s, r) => s + (r[5] || 0), 0);
        return { timestampMs: new Date(c[0][0]).getTime(), open, high, low, close, volume };
      }
    } catch (_) { /* ignore */ }
    await sleep(Math.min(1000 * 2 ** a, 15000));
  }
  return null;
}

// --- indicators not in indicators.js ---------------------------------------
function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  const tr = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) { tr[i] = c.high - c.low; continue; }
    const p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// --- resampling (match pandas W-FRI / month-end + ffill) --------------------
function weekEndFridayMs(ms) {
  const d = new Date(ms + (5 * 60 + 30) * 60000); // shift to IST wall clock
  const wd = d.getUTCDay();                        // 0=Sun..6=Sat
  const offset = (5 - wd + 7) % 7;                 // days until Friday (Fri=5 in getUTCDay)
  d.setUTCDate(d.getUTCDate() + offset);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function monthKey(ms) {
  const d = new Date(ms + (5 * 60 + 30) * 60000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}
function resample(candles, keyFn) {
  const buckets = new Map();
  for (const c of candles) {
    const k = keyFn(c.timestampMs);
    if (!buckets.has(k)) buckets.set(k, { key: k, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, lastMs: c.timestampMs });
    else {
      const b = buckets.get(k);
      b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low);
      b.close = c.close; b.volume += c.volume; b.lastMs = c.timestampMs;
    }
  }
  return [...buckets.values()].sort((a, b) => a.key - b.key);
}
/** last resampled-bucket index whose bucket key <= the daily bar's key (ffill, lookahead-safe). */
function bucketIdxForDaily(buckets, dailyMs, keyFn) {
  const k = keyFn(dailyMs);
  let idx = -1;
  for (let i = 0; i < buckets.length; i++) { if (buckets[i].key <= k) idx = i; else break; }
  return idx;
}

// --- trimmed simulate (½ at +2R, trail under 20-EMA), matches forward_scan.py ----
function simulateTrimmed(daily, entryIdx, entry, stop, ema20) {
  const R = entry - stop;
  if (R <= 0) return { status: 'void' };
  const tgt = entry + 2 * R;
  let half = false, trail = stop, halfIdx = null, halfPx = null;
  for (let j = entryIdx; j < daily.length; j++) {
    const c = daily[j];
    if (!half && c.low <= trail) return closed(j, trail, (trail - entry) / R);
    if (!half && c.high >= tgt) { half = true; trail = entry; halfIdx = j; halfPx = tgt; }
    if (half) {
      if (ema20[j] != null) trail = Math.max(trail, ema20[j]);
      if (c.low <= trail) return closed(j, trail, 0.5 * 2 + 0.5 * (trail - entry) / R);
    }
  }
  return { status: 'open', halfIdx, halfPx };
  function closed(j, exitPx, r) {
    return { status: 'closed', exitIdx: j, exitPx, r, rNet: r - COST / (R / entry), halfIdx, halfPx };
  }
}

// --- per-symbol analysis ----------------------------------------------------
function analyzeSymbol(symbol, daily) {
  if (!daily || daily.length < 130) return [];
  const ema9 = ema(daily, 9), sma20 = sma(daily, 20), ema20 = ema(daily, 20);
  const rsiD = rsi(daily, 14), volSma = sma(daily, 20, 'volume'), atr14 = atr(daily, 14);
  const weekly = resample(daily, weekEndFridayMs);
  const wSma50 = sma(weekly, 50), wRsi = rsi(weekly, 14);
  const monthly = resample(daily, monthKey);
  const mRsi = rsi(monthly, 14);

  const out = [];
  const start = Math.max(60, daily.length - SIGNAL_LOOKBACK);
  let i = start;
  while (i < daily.length) {
    // Rule 3: daily 9/20 golden cross + volume breakout
    const trig = isGoldenCross(ema9, sma20, i) && volSma[i] != null && daily[i].volume > 1.2 * volSma[i];
    if (!trig) { i++; continue; }
    // Rule 1: fresh recently-touched demand zone at i
    const zones = recentlyTouchedUninvalidatedZones(daily, i, 'DEMAND', 10);
    const zone = zones[0];
    // Rule 2: weekly trend up as of this daily bar
    const wIdx = bucketIdxForDaily(weekly, daily[i].timestampMs, weekEndFridayMs);
    const trendUp = wIdx >= 5 && wSma50[wIdx] != null && isSmaRising(wSma50, wIdx, 5) && daily[i].close > wSma50[wIdx];
    if (!zone || !trendUp) { i++; continue; }

    // RSI record (not a gate)
    const mIdx = bucketIdxForDaily(monthly, daily[i].timestampMs, monthKey);
    const rD = rsiD[i], rW = wRsi[wIdx], rM = mRsi[mIdx];
    const rsiGatePass = rD != null && rW != null && rM != null && rD >= 55 && rW >= 50 && rM >= 50;

    const stop = zone.distal - 0.25 * (atr14[i] ?? 0);
    const signalDate = istDateStr(daily[i].timestampMs);
    const rules = {
      zone: { pass: true, proximal: round(zone.proximal), distal: round(zone.distal), score: zone.score?.total, base_candles: zone.baseCount },
      trend: { pass: true, wsma50: round(wSma50[wIdx]), rising: true, priceAbove: true },
      trigger: { pass: true, ema9: round(ema9[i]), sma20: round(sma20[i]), vol: daily[i].volume, vol_avg: round(volSma[i]) },
      rsi: { pass: rsiGatePass, d: round(rD, 0), w: round(rW, 0), m: round(rM, 0) },
    };

    const last = daily[daily.length - 1];
    if (i + 1 >= daily.length) {
      // signal on the latest bar — entry not yet available
      out.push({ symbol, signalDate, status: 'pending', entryDate: null, entryPx: null,
        stopPx: round(stop), rPerShare: null, riskPct: null, target1Px: null,
        halfDate: null, halfPrice: null,
        exitDate: null, exitPx: null, rNet: null, sinceAlertPct: null, lastPrice: round(last.close),
        rsiGatePass, rules });
      i++; continue;
    }
    const entry = daily[i + 1].open;
    const R = entry - stop;
    if (R <= 0) { i++; continue; }
    const sim = simulateTrimmed(daily, i + 1, entry, stop, ema20);
    const halfDate = sim.halfIdx != null ? istDateStr(daily[sim.halfIdx].timestampMs) : null;
    const halfPrice = sim.halfPx != null ? round(sim.halfPx) : null;
    const base = {
      symbol, signalDate, stopPx: round(stop), rPerShare: round(R), riskPct: round((R / entry) * 100, 1),
      target1Px: round(entry + 2 * R), entryDate: istDateStr(daily[i + 1].timestampMs), entryPx: round(entry),
      lastPrice: round(last.close), rsiGatePass, rules, halfDate, halfPrice,
    };
    if (sim.status === 'closed') {
      out.push({ ...base, status: 'closed', exitDate: istDateStr(daily[sim.exitIdx].timestampMs),
        exitPx: round(sim.exitPx), rNet: round(sim.rNet), sinceAlertPct: round(((sim.exitPx - entry) / entry) * 100, 1) });
      i = sim.exitIdx + 1; // one position per symbol at a time
    } else {
      out.push({ ...base, status: 'open', exitDate: null, exitPx: null, rNet: null,
        sinceAlertPct: round(((last.close - entry) / entry) * 100, 1) });
      break; // still open — no further signals until it resolves
    }
  }
  return out;
}

// --- orchestration ----------------------------------------------------------
async function runOnce() {
  const db = new SwingDB();
  await db.init();
  const existing = await db.allExisting(); // symbol|signalDate -> {status, halfDate, exitDate, rs_rank_at_entry}, from BEFORE this run's writes
  const symbols = Object.keys(symbolMap);
  const today = istDateStr();
  let signals = 0, open = 0, closed = 0, pending = 0, errs = 0;
  const alerts = [];
  console.log(`[${new Date().toISOString()}] trimmed swing run over ${symbols.length} symbols...`);

  console.log('Fetching Nifty 50 (for RS rank)...');
  const nifty = await fetchDaily('NSE_INDEX|Nifty 50');

  // Pass 1: fetch + signal-detect per symbol, same as before -- but don't upsert/alert
  // yet. rsRankAtEntry needs EVERY symbol's daily data collected first (cross-sectional
  // percentile ranking can't be computed one symbol at a time), so that has to wait
  // for pass 2 below.
  const perSymbol = []; // { symbol, daily, rows }
  for (const symbol of symbols) {
    try {
      const daily = await fetchDaily(symbolMap[symbol]);
      if (!daily || !daily.length) { errs++; continue; }
      // append today's synthesized bar if the official daily bar hasn't posted
      if (istDateStr(daily[daily.length - 1].timestampMs) !== today) {
        const tb = await fetchTodayBar(symbolMap[symbol]);
        if (tb) daily.push(tb);
      }
      const rows = analyzeSymbol(symbol, daily);
      perSymbol.push({ symbol, daily, rows });
    } catch (e) {
      errs++; console.warn(`  ${symbol}: ${e.message}`);
    }
    await sleep(FETCH_DELAY_MS);
  }

  console.log('Computing today\'s RS ranks from this run\'s own data...');
  const dailyBySymbol = {};
  for (const { symbol, daily } of perSymbol) dailyBySymbol[symbol] = daily;
  const todayRsRanks = nifty ? computeTodayRsRanks(dailyBySymbol, nifty, today) : new Map();

  // Pass 2: upsert + alert, now that todayRsRanks is fully known.
  for (const { rows } of perSymbol) {
    for (const r of rows) {
      const prev = existing.get(`${r.symbol}|${r.signalDate}`);
      // "today" here means this run just observed the transition — since the runner is
      // stateless and only runs once/day, prev-vs-now is equivalent to "changed today".
      // rsRankAtEntry: stamp it ONLY the run a signal is genuinely brand new (same
      // condition as the "new signal" alert below -- pending only ever happens on
      // signalDate === today, see analyzeSymbol). Every later run of the SAME
      // signal (pending -> open -> closed) carries the already-stamped value
      // forward unchanged, rather than recomputing today's rank again -- that's
      // what makes this "at entry" instead of just a second copy of the live rank.
      r.rsRankAtEntry = (!prev && r.status === 'pending')
        ? (todayRsRanks.get(r.symbol) ?? null)
        : (prev?.rs_rank_at_entry ?? null);
      if (!prev && r.status === 'pending') alerts.push(formatNewSignalAlert(r));
      if (r.halfDate === today && prev?.halfDate !== today) alerts.push(formatHalfBookAlert(r));
      if (r.status === 'closed' && r.exitDate === today && prev?.status !== 'closed') alerts.push(formatExitAlert(r));
      await db.upsertSignal(r);
      signals++;
      if (r.status === 'open') open++; else if (r.status === 'closed') closed++; else pending++;
    }
  }
  console.log(`[${istDateStr()}] DONE — signals=${signals} open=${open} pending=${pending} closed=${closed} errs=${errs} alerts=${alerts.length}`);
  for (const text of alerts) await sendTelegramAlert(text);
  await db.close();
  return { signals, open, pending, closed, errs, alerts: alerts.length };
}

module.exports = { runOnce, analyzeSymbol, simulateTrimmed, resample, weekEndFridayMs };

if (require.main === module) {
  runOnce().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
