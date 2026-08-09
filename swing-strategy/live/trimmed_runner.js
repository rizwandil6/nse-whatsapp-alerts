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

const symbolMap = require('./symbols.json');

const COST = 0.0025;
const SIGNAL_LOOKBACK = 130;   // daily bars back to scan for fired signals (> ~90d hold)
const FETCH_YEARS = 3;
const FETCH_DELAY_MS = 100;    // polite, sequential
const UPSTOX_BASE = 'https://api.upstox.com/v2';
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || 'public'; // candle endpoints are public

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d = 2) => (x == null || Number.isNaN(x) ? null : Number(x.toFixed(d)));

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
  let half = false, trail = stop;
  for (let j = entryIdx; j < daily.length; j++) {
    const c = daily[j];
    if (!half && c.low <= trail) return closed(j, trail, (trail - entry) / R);
    if (!half && c.high >= tgt) { half = true; trail = entry; }
    if (half) {
      if (ema20[j] != null) trail = Math.max(trail, ema20[j]);
      if (c.low <= trail) return closed(j, trail, 0.5 * 2 + 0.5 * (trail - entry) / R);
    }
  }
  return { status: 'open' };
  function closed(j, exitPx, r) {
    return { status: 'closed', exitIdx: j, exitPx, r, rNet: r - COST / (R / entry) };
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
        exitDate: null, exitPx: null, rNet: null, sinceAlertPct: null, lastPrice: round(last.close),
        rsiGatePass, rules });
      i++; continue;
    }
    const entry = daily[i + 1].open;
    const R = entry - stop;
    if (R <= 0) { i++; continue; }
    const sim = simulateTrimmed(daily, i + 1, entry, stop, ema20);
    const base = {
      symbol, signalDate, stopPx: round(stop), rPerShare: round(R), riskPct: round((R / entry) * 100, 1),
      target1Px: round(entry + 2 * R), entryDate: istDateStr(daily[i + 1].timestampMs), entryPx: round(entry),
      lastPrice: round(last.close), rsiGatePass, rules,
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
  const symbols = Object.keys(symbolMap);
  const today = istDateStr();
  let signals = 0, open = 0, closed = 0, pending = 0, errs = 0;
  console.log(`[${new Date().toISOString()}] trimmed swing run over ${symbols.length} symbols...`);

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
      for (const r of rows) {
        await db.upsertSignal(r);
        signals++;
        if (r.status === 'open') open++; else if (r.status === 'closed') closed++; else pending++;
      }
    } catch (e) {
      errs++; console.warn(`  ${symbol}: ${e.message}`);
    }
    await sleep(FETCH_DELAY_MS);
  }
  console.log(`[${istDateStr()}] DONE — signals=${signals} open=${open} pending=${pending} closed=${closed} errs=${errs}`);
  await db.close();
  return { signals, open, pending, closed, errs };
}

module.exports = { runOnce, analyzeSymbol, simulateTrimmed, resample, weekEndFridayMs };

if (require.main === module) {
  runOnce().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
