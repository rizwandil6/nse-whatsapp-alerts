'use strict';

/**
 * Per-symbol state machine for the MTF Ichimoku trend system ("The Secret
 * Mindset" — wiki/concepts/ichimoku-cloud.md "Trading strategy — multi-
 * timeframe (MTF) trend system", full spec in
 * wiki/sources/secretmindset-ichimoku-mtf-strategy-video.md).
 *
 * Day-trading timeframe trio: Highest = 1H, Middle = 30min, Entry = 5min.
 * Standard Ichimoku (9/26/26, see ichimoku.js) computed on 1H and 30min.
 * On the entry TF (5min) the only indicators that matter for the trigger are
 * the Baseline (Kijun-26) and a 200 EMA -- cloud/Tenkan/Chikou are NOT used
 * for the entry trigger itself, but Chikou-vs-cloud IS still computed on the
 * entry TF purely as an invalidation gate (rule 20 of the source video's
 * extraction).
 *
 * LONG entry -- ALL must hold on the same evaluation (mirror for SHORT):
 *   1. 1H:   price above cloud AND price above baseline (green cloud not required here).
 *   2. 30m:  price above cloud AND price above baseline AND cloud green (mandatory).
 *   3. 5m trigger: Baseline (Kijun) above the 200 EMA.
 *   4. Invalidation gate (5m): price NOT inside the cloud body, AND Chikou
 *      (5m) NOT inside the cloud -- if either is true, the setup does not
 *      fire even if 1-3 hold.
 *
 * Stop = far side of the 200 EMA, pushed STOP_BUFFER_PCT further away (env
 * var, default 0.15%, see README -- explicitly a placeholder pending the
 * user's own risk-per-trade discussion, same reasoning pattern as
 * ichimoku-momentum-strategy's SL_BUFFER_PCT).
 * Target = fixed 2R.
 * Early-exit warning (alert-only, no auto-exit, edge-triggered once per open
 * trade): Baseline crosses back through the 200 EMA against the position.
 *
 * Cooldown / re-entry state machine: once a signal fires for a symbol, no new
 * signal fires until the open trade's outcome (TARGET or SL) is reached.
 * There is no separate "wait for conditions to break and reform" timer to
 * implement on top of that -- reaching an outcome alone is sufficient per the
 * spec's "(a) OR (b)" wording, and while a trade is open no new evaluation
 * happens anyway (so entry conditions flapping mid-trade is a non-event).
 * The (b) clause ("conditions broke and reformed") is naturally satisfied by
 * construction: a signal only ever fires the instant all 4 conditions first
 * become simultaneously true, so there is never a window where conditions
 * are continuously true without either an open trade or a fired signal.
 */

const { DISPLACEMENT, kijun, cloudAt } = require('./ichimoku');
const { emaAt } = require('./ema');

const EMA_LEN = 200;
const TARGET_R = 2; // fixed 2:1 risk-reward, per the source video's stated default
const STOP_BUFFER_PCT = Number(process.env.STOP_BUFFER_PCT || 0.15) / 100; // default 0.15%, see README

/** 1H / 30m alignment check against a bar array. Returns null if not enough lookback yet. */
function higherTfState(bars) {
  const i = bars.length - 1;
  if (i < 0) return null;
  const cloud = cloudAt(bars, i);
  const kj = kijun(bars, i);
  if (!cloud || kj == null) return null;
  const close = bars[i].close;
  return {
    close, cloud, kijun: kj,
    aboveCloudAndBaseline: close > cloud.top && close > kj,
    belowCloudAndBaseline: close < cloud.bottom && close < kj,
    cloudGreen: cloud.green,
    cloudRed: !cloud.green,
  };
}

/** Entry-TF (5m) state: Kijun vs 200 EMA trigger + the price/Chikou invalidation gate. */
function entryTfState(bars) {
  const i = bars.length - 1;
  if (i < 0) return null;
  const kj = kijun(bars, i);
  const ema200 = emaAt(bars, i, EMA_LEN);
  if (kj == null || ema200 == null) return null;

  const cloud = cloudAt(bars, i); // cloud hovering over price right now, for the invalidation gate
  const close = bars[i].close;
  let priceInsideCloud = false;
  if (cloud) priceInsideCloud = close <= cloud.top && close >= cloud.bottom;

  let chikouInsideCloud = false;
  let chikouReady = false;
  const chikouCloud = cloudAt(bars, i - DISPLACEMENT); // cloud that was hovering 26 bars back
  if (chikouCloud) {
    chikouReady = true;
    chikouInsideCloud = close <= chikouCloud.top && close >= chikouCloud.bottom;
  }

  return {
    close, kijun: kj, ema200,
    kijunAboveEma: kj > ema200,
    kijunBelowEma: kj < ema200,
    invalidated: priceInsideCloud || (chikouReady && chikouInsideCloud),
    gateReady: chikouReady, // invalidation gate needs the 26-back cloud too; without it we can't clear the gate
    priceInsideCloud,
    chikouInsideCloud: chikouReady ? chikouInsideCloud : null,
  };
}

class MtfSymbolTracker {
  constructor(symbol) {
    this.symbol = symbol;
    this.h1 = [];
    this.m30 = [];
    this.m5 = [];
    this.trade = null; // { direction, entryTs, entryPx, stop, target, r, kijunAboveEmaAtOpen, warningFired, closed }
  }

  seedHistory({ h1 = [], m30 = [], m5 = [] } = {}) {
    this.h1 = h1.slice().sort((a, b) => a.timestampMs - b.timestampMs);
    this.m30 = m30.slice().sort((a, b) => a.timestampMs - b.timestampMs);
    this.m5 = m5.slice().sort((a, b) => a.timestampMs - b.timestampMs);
  }

  addH1Bar(bar) { pushSorted(this.h1, bar); }
  addM30Bar(bar) { pushSorted(this.m30, bar); }

  /** The entry TF driving loop -- call once per completed 5min bar. Returns an events array. */
  addM5Bar(bar) {
    pushSorted(this.m5, bar);
    const events = [];
    if (this.trade && !this.trade.closed) events.push(...this._track(bar));
    if (this.trade && this.trade.closed) this.trade = null;
    if (!this.trade) {
      const setup = this._tryEnter(bar);
      if (setup) events.push(setup);
    }
    return events;
  }

  _tryEnter(bar) {
    const h1s = higherTfState(this.h1);
    const m30s = higherTfState(this.m30);
    const m5s = entryTfState(this.m5);
    if (!h1s || !m30s || !m5s || !m5s.gateReady) return null; // not enough lookback anywhere yet

    const longOk = h1s.aboveCloudAndBaseline && m30s.aboveCloudAndBaseline && m30s.cloudGreen
      && m5s.kijunAboveEma && !m5s.invalidated;
    const shortOk = h1s.belowCloudAndBaseline && m30s.belowCloudAndBaseline && m30s.cloudRed
      && m5s.kijunBelowEma && !m5s.invalidated;
    if (!longOk && !shortOk) return null;

    const direction = longOk ? 'LONG' : 'SHORT';
    const entry = bar.close;
    const ema200 = m5s.ema200;
    const stop = direction === 'LONG' ? ema200 * (1 - STOP_BUFFER_PCT) : ema200 * (1 + STOP_BUFFER_PCT);
    const r = direction === 'LONG' ? entry - stop : stop - entry;
    if (!(r > 0)) return null; // degenerate (EMA + buffer landed on the wrong side of entry) -- skip

    const target = direction === 'LONG' ? entry + TARGET_R * r : entry - TARGET_R * r;

    this.trade = {
      direction, entryTs: bar.timestampMs, entryPx: entry, stop, target, r, ema200At: ema200,
      criteria: {
        h1: direction === 'LONG' ? 'aboveCloud+aboveBaseline' : 'belowCloud+belowBaseline',
        m30: direction === 'LONG' ? 'aboveCloud+aboveBaseline+greenCloud' : 'belowCloud+belowBaseline+redCloud',
        m5Trigger: direction === 'LONG' ? 'kijunAboveEma200' : 'kijunBelowEma200',
        invalidationGate: 'clear',
      },
      warningFired: false, closed: false, mfeR: 0, maeR: 0,
    };
    return { type: 'SETUP', symbol: this.symbol, ...this.trade };
  }

  _track(bar) {
    const s = this.trade;
    if (bar.timestampMs <= s.entryTs) return [];
    const events = [];
    const long = s.direction === 'LONG';

    const favPx = long ? bar.high : bar.low;
    const advPx = long ? bar.low : bar.high;
    s.mfeR = Math.max(s.mfeR, (long ? favPx - s.entryPx : s.entryPx - favPx) / s.r);
    s.maeR = Math.min(s.maeR, (long ? advPx - s.entryPx : s.entryPx - advPx) / s.r);

    // Early-exit warning: Baseline crosses back through the 200 EMA against the position.
    if (!s.warningFired) {
      const m5s = entryTfState(this.m5);
      if (m5s) {
        const against = long ? m5s.kijunBelowEma : m5s.kijunAboveEma;
        if (against) {
          s.warningFired = true;
          events.push({
            type: 'WARNING', symbol: this.symbol, direction: s.direction, ts: bar.timestampMs,
            kijun: m5s.kijun, ema200: m5s.ema200, price: bar.close,
          });
        }
      }
    }

    const hitSL = long ? bar.low <= s.stop : bar.high >= s.stop;
    const hitTarget = long ? bar.high >= s.target : bar.low <= s.target;

    if (hitSL) { events.push(this._close('SL', s.stop, bar.timestampMs, -1)); return events; }
    if (hitTarget) { events.push(this._close('TARGET', s.target, bar.timestampMs, TARGET_R)); return events; }
    return events;
  }

  _close(result, exitPx, ts, rMultiple) {
    const s = this.trade;
    s.closed = true;
    return {
      type: 'OUTCOME', result, symbol: this.symbol, direction: s.direction,
      exitPx, closedTs: ts, rMultiple, entryTs: s.entryTs, entryPx: s.entryPx,
      warningFired: s.warningFired, mfeR: s.mfeR, maeR: s.maeR,
    };
  }
}

function pushSorted(arr, bar) {
  if (arr.length && arr[arr.length - 1].timestampMs === bar.timestampMs) { arr[arr.length - 1] = bar; return; }
  arr.push(bar);
  if (arr.length > 1 && arr[arr.length - 2].timestampMs > bar.timestampMs) arr.sort((a, b) => a.timestampMs - b.timestampMs);
}

module.exports = { MtfSymbolTracker, higherTfState, entryTfState, TARGET_R, STOP_BUFFER_PCT, EMA_LEN };
