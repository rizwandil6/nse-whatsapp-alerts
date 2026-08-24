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
 * Early reversal exit (changed 2026-08-22 from a discretionary alert to a
 * hard rule, per the user's request): Baseline crossing back through the
 * 200 EMA against the position closes the tracked (virtual) position
 * immediately at that bar's close, logged as result WARNING_EXIT -- same
 * footing as SL/TARGET, not just an informational nudge to act on manually.
 * Checked AFTER the intrabar SL/TARGET check on each bar, since an actual
 * stop/target hit within the bar is a harder outcome than the close-based
 * Kijun/EMA heuristic.
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
  /**
   * entriesEnabled=false marks a "phase-out" symbol: it still tracks an
   * already-open position through to a real outcome (SL/TARGET/WARNING_EXIT),
   * but never fires a fresh SETUP. Used when swapping the tracked symbol set
   * (e.g. BTCUSDT/XAUUSDT -> BTCINR/XAUINR, 2026-08-23) without abandoning
   * whatever's still open on the old symbol -- same "don't orphan an open
   * position" principle as the restart-resume fix, just for a deliberate
   * symbol-set change instead of a process restart.
   */
  constructor(symbol, opts = {}) {
    this.symbol = symbol;
    this.entriesEnabled = opts.entriesEnabled !== false;
    this.h1 = [];
    this.m30 = [];
    this.m5 = [];
    this.trade = null; // { direction, entryTs, entryPx, stop, target, r, kijunAboveEmaAtOpen, warningFired, closed }
    this._lastDiagnostic = null; // set by _tryEnter() on every evaluated bar, see addM5Bar
  }

  seedHistory({ h1 = [], m30 = [], m5 = [] } = {}) {
    this.h1 = h1.slice().sort((a, b) => a.timestampMs - b.timestampMs);
    this.m30 = m30.slice().sort((a, b) => a.timestampMs - b.timestampMs);
    this.m5 = m5.slice().sort((a, b) => a.timestampMs - b.timestampMs);
  }

  addH1Bar(bar) { pushSorted(this.h1, bar); }
  addM30Bar(bar) { pushSorted(this.m30, bar); }

  /**
   * Resume an OPEN position from a persisted DB row after a process restart
   * (see db.js#getOpenSignal). Without this, every restart forgets the open
   * trade and re-enters on the next qualifying candle -- producing duplicate
   * signals and orphaning the original's outcome forever (2026-08-21 bug).
   *
   * Catch-up uses each seeded m5 bar's own high/low directly (NOT _track(),
   * which derives its warning check from entryTfState(this.m5) -- that reads
   * bars[bars.length-1], i.e. always the newest bar, not "as of this bar in
   * the loop". Reusing _track() here would silently check the wrong bar for
   * every replayed step except the last. Stop/target/MFE/MAE only need each
   * bar's own high/low so those ARE safe to replay directly; the warning
   * check is evaluated once against current (latest) state instead, which is
   * equivalent to what live operation would do on the very next tick anyway.
   * Returns the events generated by catch-up (possibly empty).
   */
  resumeTrade(row) {
    const entryPx = Number(row.entry_px);
    const stop = Number(row.stop_px);
    const target = Number(row.target_px);
    const r = Number(row.r_value);
    const s = {
      direction: row.direction, entryTs: new Date(row.entry_ts).getTime(), entryPx,
      stop, target, r, ema200At: row.ema200_at_entry == null ? null : Number(row.ema200_at_entry),
      criteria: row.criteria || {}, warningFired: !!row.warning_fired,
      closed: false, mfeR: 0, maeR: 0,
    };
    this.trade = s;
    const long = s.direction === 'LONG';
    const events = [];

    for (const bar of this.m5) {
      if (bar.timestampMs <= s.entryTs) continue;
      if (s.closed) break;
      const favPx = long ? bar.high : bar.low;
      const advPx = long ? bar.low : bar.high;
      s.mfeR = Math.max(s.mfeR, (long ? favPx - s.entryPx : s.entryPx - favPx) / s.r);
      s.maeR = Math.min(s.maeR, (long ? advPx - s.entryPx : s.entryPx - advPx) / s.r);
      const hitSL = long ? bar.low <= s.stop : bar.high >= s.stop;
      const hitTarget = long ? bar.high >= s.target : bar.low <= s.target;
      if (hitSL) { events.push(this._close('SL', s.stop, bar.timestampMs, -1)); break; }
      if (hitTarget) { events.push(this._close('TARGET', s.target, bar.timestampMs, TARGET_R)); break; }
    }

    if (s.closed) { this.trade = null; return events; }

    // Same reversal-closes-the-trade rule as _track() (2026-08-22). Evaluated once against
    // current (latest) state rather than per-historical-bar -- see the class doc comment above
    // for why per-bar replay isn't safe here (entryTfState always reads the newest bar).
    const m5s = entryTfState(this.m5);
    if (m5s) {
      const against = long ? m5s.kijunBelowEma : m5s.kijunAboveEma;
      if (against) {
        s.warningFired = true;
        const lastBar = this.m5[this.m5.length - 1];
        const exitPx = lastBar ? lastBar.close : s.entryPx;
        const ts = lastBar ? lastBar.timestampMs : Date.now();
        const rMultiple = (long ? exitPx - s.entryPx : s.entryPx - exitPx) / s.r;
        const outcome = this._close('WARNING_EXIT', exitPx, ts, rMultiple);
        outcome.kijun = m5s.kijun;
        outcome.ema200 = m5s.ema200;
        events.push(outcome);
        this.trade = null;
      }
    }
    return events;
  }

  /** The entry TF driving loop -- call once per completed 5min bar. Returns an events array. */
  addM5Bar(bar) {
    pushSorted(this.m5, bar);
    const events = [];
    if (this.trade && !this.trade.closed) events.push(...this._track(bar));
    if (this.trade && this.trade.closed) this.trade = null;
    if (!this.trade && this.entriesEnabled) {
      const setup = this._tryEnter(bar);
      // DIAGNOSTIC fires on every completed bar entry is evaluated, not just when a
      // SETUP actually fires -- added 2026-08-24 so "why didn't it fire an hour ago"
      // has a real per-bar log trail (via streamer.js's console-only logging, no
      // Telegram/DB) instead of only being answerable from a live snapshot at
      // whatever moment someone happens to ask.
      if (this._lastDiagnostic) events.push(this._lastDiagnostic);
      if (setup) events.push(setup);
    }
    return events;
  }

  _tryEnter(bar) {
    const h1s = higherTfState(this.h1);
    const m30s = higherTfState(this.m30);
    const m5s = entryTfState(this.m5);
    const lookbackReady = !!(h1s && m30s && m5s && m5s.gateReady);
    this._lastDiagnostic = {
      type: 'DIAGNOSTIC', symbol: this.symbol, ts: bar.timestampMs, close: bar.close, lookbackReady,
    };
    if (!lookbackReady) return null; // not enough lookback anywhere yet

    const longOk = h1s.aboveCloudAndBaseline && m30s.aboveCloudAndBaseline && m30s.cloudGreen
      && m5s.kijunAboveEma && !m5s.invalidated;
    const shortOk = h1s.belowCloudAndBaseline && m30s.belowCloudAndBaseline && m30s.cloudRed
      && m5s.kijunBelowEma && !m5s.invalidated;
    Object.assign(this._lastDiagnostic, {
      h1: { aboveCloudAndBaseline: h1s.aboveCloudAndBaseline, belowCloudAndBaseline: h1s.belowCloudAndBaseline, cloudGreen: h1s.cloudGreen },
      m30: { aboveCloudAndBaseline: m30s.aboveCloudAndBaseline, belowCloudAndBaseline: m30s.belowCloudAndBaseline, cloudGreen: m30s.cloudGreen, cloudRed: m30s.cloudRed },
      m5: { kijunAboveEma: m5s.kijunAboveEma, kijunBelowEma: m5s.kijunBelowEma, invalidated: m5s.invalidated },
      longOk, shortOk,
    });
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

    // Stop/target are intrabar (use the bar's full high/low range) so they take priority over
    // the close-based reversal check below -- an actual stop/target hit within the bar is a
    // harder, more definite outcome than the Kijun/EMA heuristic.
    const hitSL = long ? bar.low <= s.stop : bar.high >= s.stop;
    const hitTarget = long ? bar.high >= s.target : bar.low <= s.target;

    if (hitSL) { events.push(this._close('SL', s.stop, bar.timestampMs, -1)); return events; }
    if (hitTarget) { events.push(this._close('TARGET', s.target, bar.timestampMs, TARGET_R)); return events; }

    // Early reversal exit (2026-08-22, changed from a discretionary warning to a hard close per
    // the user's request): Baseline crossing back through the 200 EMA against the position
    // closes the tracked (virtual) position immediately at the bar's close, logged as a real
    // outcome (WARNING_EXIT) rather than just an informational alert the user has to act on
    // manually. Video's own framing treated this as optional judgment; this system treats it as
    // a rule, same footing as SL/TARGET.
    const m5s = entryTfState(this.m5);
    if (m5s) {
      const against = long ? m5s.kijunBelowEma : m5s.kijunAboveEma;
      if (against) {
        s.warningFired = true;
        const exitPx = bar.close;
        const rMultiple = (long ? exitPx - s.entryPx : s.entryPx - exitPx) / s.r;
        const outcome = this._close('WARNING_EXIT', exitPx, bar.timestampMs, rMultiple);
        outcome.kijun = m5s.kijun;
        outcome.ema200 = m5s.ema200;
        events.push(outcome);
      }
    }
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
