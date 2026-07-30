'use strict';

/**
 * Live incremental port of renko-python-backtest/williams_r_backtest.py's
 * run_backtest() -- specifically the ONE combo backtested and confirmed
 * with the user before building this: period=14, oversold=-90,
 * overbought=-10, confirm_n=2, sl_lookback=None (NO stop-loss), on 5-min
 * candles. That combo (2026-07-30 backtest, today's data) returned 13
 * trades, 84.6% win rate, +₹1,492 -- not the single best combo of the
 * session, but the one the user explicitly asked to go live with.
 *
 * STRATEGY (exact mirror of the backtest's state machine, not a
 * simplification):
 *   LONG entry:  %R crosses below oversold (-90) -> watch for confirmation
 *                on a LATER bar (never the crossing bar itself) -> confirmed
 *                by EITHER 2 consecutive upward %R ticks while still below
 *                oversold, OR a single bullish bar (close>open) with a
 *                higher low than the prior bar -> position opens at the
 *                NEXT bar's open (backtest's "no lookahead" rule).
 *   LONG exit:   %R crosses above overbought (-10) -- the SAME value that
 *                would trigger a SHORT entry. Full oversold-to-overbought
 *                round-trip mean reversion, not a return to neutral.
 *   SHORT entry/exit: exact mirror at the overbought/oversold boundary.
 *   No stop-loss of any kind (user's explicit choice) -- a losing trade
 *                rides until the opposite %R threshold, however long that
 *                takes within the SAME trading day.
 *   Forced EOD square-off (added 2026-07-30, user's explicit choice,
 *                DIVERGING from the exact backtest here on purpose): any
 *                open position is force-closed at market close, same as
 *                DarvasBox -- caps overnight/weekend gap exposure that the
 *                pure %R exit alone doesn't. See forceEodClose(). Only the
 *                POSITION is closed at EOD -- pendingEntry/watch-state/
 *                streaks are left running into the next day untouched,
 *                since those track the INDICATOR's own state (continuous,
 *                like %R itself), not open exposure, and resetting them
 *                wasn't part of what was asked for.
 *
 * LIVE-SPECIFIC ADDITIONS (this project's established convention, same as
 * DarvasBox's shadow tracker):
 *   - Entry/exit priced at LIVE LTP when available (falls back to the
 *     theoretical bar open/close otherwise) -- only for the NEWEST bar in
 *     any given processBars() call, since older bars being caught up
 *     during a gap-backfill have no live price to attach and must replay
 *     deterministically at their own theoretical prices.
 *   - Incremental by TIMESTAMP, not array index: unlike DarvasBox (which
 *     rebuilds its brick series fresh every day and can safely track "how
 *     many bricks processed so far" as a plain count), a restart here
 *     re-fetches a FRESH lookback window of unknown/different length -- an
 *     index-based cursor would silently misalign. lastProcessedTimestampMs
 *     is persisted instead (see toJSON/fromJSON), and every call filters
 *     bars5 to strictly-after that timestamp, so re-running with a
 *     differently sized bars5 array is always safe. Still needed even with
 *     EOD square-off added: a position can still be open mid-day across a
 *     restart, same as every other live/ service here.
 */

const PERIOD = 14;
const OVERSOLD = -90;
const OVERBOUGHT = -10;
const CONFIRM_N = 2;

/** Standard %R, scale -100..0. null for the first `period`-1 bars (warm-up) or a flat window (undefined). */
function williamsR(highs, lows, closes, period) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    const denom = hh - ll;
    out[i] = denom === 0 ? null : ((hh - closes[i]) / denom) * -100;
  }
  return out;
}

class WilliamsRLiveTracker {
  constructor(symbol, getLivePriceFn) {
    this.symbol = symbol;
    this.getLivePriceFn = getLivePriceFn || (() => null);
    this.position = null; // { direction, entry, entryTimestampMs, entryR }
    this.pendingEntry = null; // { direction, entryR } -- set on the confirming bar, resolved on the NEXT bar processed
    this.longWatch = false;
    this.longUpStreak = 0;
    this.shortWatch = false;
    this.shortDownStreak = 0;
    this.lastProcessedTimestampMs = null; // null = never processed a bar yet for this symbol
  }

  _liveOrTheoretical(theoreticalPrice) {
    const live = this.getLivePriceFn();
    return { price: live != null ? live : theoreticalPrice, livePriceAvailable: live != null, theoreticalPrice };
  }

  /**
   * bars5: ALL bars available (continuous, ascending, oldest first) -- may
   * include bars already processed in a prior call; only ones strictly
   * after lastProcessedTimestampMs are newly considered. %R is computed
   * over the FULL array every call (cheap at these sizes) so the rolling
   * window always has correct history even for the first newly-considered
   * bar. Returns new ENTRY/EXIT events since the last call.
   */
  processBars(bars5) {
    const n = bars5.length;
    if (n === 0) return [];

    const o = bars5.map((b) => b.open);
    const h = bars5.map((b) => b.high);
    const l = bars5.map((b) => b.low);
    const c = bars5.map((b) => b.close);
    const r = williamsR(h, l, c, PERIOD);

    let start = 0;
    if (this.lastProcessedTimestampMs != null) {
      while (start < n && bars5[start].timestampMs <= this.lastProcessedTimestampMs) start++;
    }

    const events = [];

    for (let i = start; i < n; i++) {
      const isLatestBar = i === n - 1;

      // 1) resolve a pending entry using THIS bar's open -- "next bar's open" from the backtest's rule.
      if (this.pendingEntry && !this.position) {
        const theoreticalEntry = o[i];
        const { price: entryPrice, livePriceAvailable } = isLatestBar
          ? this._liveOrTheoretical(theoreticalEntry)
          : { price: theoreticalEntry, livePriceAvailable: false };
        this.position = {
          direction: this.pendingEntry.direction, entry: entryPrice,
          entryTimestampMs: bars5[i].timestampMs, entryR: this.pendingEntry.entryR,
        };
        events.push({
          type: 'ENTRY', symbol: this.symbol, direction: this.position.direction,
          entry: entryPrice, theoreticalEntry, timestampMs: bars5[i].timestampMs, livePriceAvailable,
        });
        this.pendingEntry = null;
      }

      if (r[i] == null) continue;

      if (this.position) {
        const direction = this.position.direction;
        if (i > 0 && r[i - 1] != null) {
          const crossed = direction === 'LONG'
            ? (r[i - 1] <= OVERBOUGHT && r[i] > OVERBOUGHT)
            : (r[i - 1] >= OVERSOLD && r[i] < OVERSOLD);
          if (crossed) {
            const theoreticalExit = c[i];
            const { price: exitPrice, livePriceAvailable } = isLatestBar
              ? this._liveOrTheoretical(theoreticalExit)
              : { price: theoreticalExit, livePriceAvailable: false };
            const pnlPct = direction === 'LONG'
              ? ((exitPrice - this.position.entry) / this.position.entry) * 100
              : ((this.position.entry - exitPrice) / this.position.entry) * 100;
            events.push({
              type: 'EXIT', symbol: this.symbol, direction, entry: this.position.entry,
              exitPrice, theoreticalExit, action: 'R_EXIT', pnlPct,
              entryTimestampMs: this.position.entryTimestampMs, exitTimestampMs: bars5[i].timestampMs,
              livePriceAvailable,
            });
            this.position = null;
          }
        }
      } else if (!this.pendingEntry) {
        if (!this.longWatch && !this.shortWatch) {
          if (i > 0 && r[i - 1] != null) {
            if (r[i - 1] >= OVERSOLD && r[i] < OVERSOLD) {
              this.longWatch = true;
              this.longUpStreak = 0;
            } else if (r[i - 1] <= OVERBOUGHT && r[i] > OVERBOUGHT) {
              this.shortWatch = true;
              this.shortDownStreak = 0;
            }
          }
        } else if (this.longWatch) {
          if (r[i] >= OVERSOLD) {
            this.longWatch = false;
          } else {
            const bullishConfirm = c[i] > o[i] && l[i] > l[i - 1];
            this.longUpStreak = r[i] > r[i - 1] ? this.longUpStreak + 1 : 0;
            if (bullishConfirm || this.longUpStreak >= CONFIRM_N) {
              this.pendingEntry = { direction: 'LONG', entryR: r[i] };
              this.longWatch = false;
            }
          }
        } else if (this.shortWatch) {
          if (r[i] <= OVERBOUGHT) {
            this.shortWatch = false;
          } else {
            const bearishConfirm = c[i] < o[i] && h[i] < h[i - 1];
            this.shortDownStreak = r[i] < r[i - 1] ? this.shortDownStreak + 1 : 0;
            if (bearishConfirm || this.shortDownStreak >= CONFIRM_N) {
              this.pendingEntry = { direction: 'SHORT', entryR: r[i] };
              this.shortWatch = false;
            }
          }
        }
      }
    }

    if (n > 0) this.lastProcessedTimestampMs = bars5[n - 1].timestampMs;
    return events;
  }

  /**
   * Force-closes an open position at market close, priced at LIVE LTP if
   * available (else the last bar's own close) -- added 2026-07-30, see
   * module docstring for why this diverges from the exact backtest.
   * Returns null if no position is open or bars5 is empty. Does NOT touch
   * pendingEntry/watch-state/streaks -- those carry into the next day.
   */
  forceEodClose(bars5) {
    if (!this.position || bars5.length === 0) return null;
    const last = bars5[bars5.length - 1];
    const theoreticalExit = last.close;
    const { price: exitPrice, livePriceAvailable } = this._liveOrTheoretical(theoreticalExit);
    const direction = this.position.direction;
    const pnlPct = direction === 'LONG'
      ? ((exitPrice - this.position.entry) / this.position.entry) * 100
      : ((this.position.entry - exitPrice) / this.position.entry) * 100;
    const event = {
      type: 'EXIT', symbol: this.symbol, direction, entry: this.position.entry,
      exitPrice, theoreticalExit, action: 'EOD_SQUARE_OFF', pnlPct,
      entryTimestampMs: this.position.entryTimestampMs, exitTimestampMs: last.timestampMs,
      livePriceAvailable,
    };
    this.position = null;
    return event;
  }

  toJSON() {
    return {
      position: this.position,
      pendingEntry: this.pendingEntry,
      longWatch: this.longWatch,
      longUpStreak: this.longUpStreak,
      shortWatch: this.shortWatch,
      shortDownStreak: this.shortDownStreak,
      lastProcessedTimestampMs: this.lastProcessedTimestampMs,
    };
  }

  static fromJSON(symbol, getLivePriceFn, json) {
    const tracker = new WilliamsRLiveTracker(symbol, getLivePriceFn);
    if (json) {
      tracker.position = json.position ?? null;
      tracker.pendingEntry = json.pendingEntry ?? null;
      tracker.longWatch = json.longWatch ?? false;
      tracker.longUpStreak = json.longUpStreak ?? 0;
      tracker.shortWatch = json.shortWatch ?? false;
      tracker.shortDownStreak = json.shortDownStreak ?? 0;
      tracker.lastProcessedTimestampMs = json.lastProcessedTimestampMs ?? null;
    }
    return tracker;
  }
}

module.exports = { WilliamsRLiveTracker, williamsR, PERIOD, OVERSOLD, OVERBOUGHT, CONFIRM_N };
