# Pine Script Indicators

TradingView Pine Script v6 indicators, each requested as an "implement
this" against a source document/notes. **A different technology from
everything else in this repo** — Pine Script runs inside TradingView
itself, not on Railway; not connected to Upstox; not backtestable with
this project's existing Node.js infrastructure. Paste the `.pine` file
into TradingView's Pine Editor to use it.

## SMC Trading Suite — `smc_trading_suite.pine`

Requested against a marketing reference doc for a third-party
closed-source tool ("Smart AI Trading Pro" by "Wizard Trader").

### What this actually is, and isn't

The reference doc describes a closed-source tool's features in marketing
language, not a technical spec. Before building, the features were split
into two groups (discussed and confirmed directly):

**Implemented — standard, disclosed, well-defined concepts:**
- Fair Value Gap (FVG) — standard 3-candle ICT definition, active/
  unmitigated gaps only.
- Order Blocks (Swing + Internal) — ported directly from this repo's own
  `smc-strategy/market_structure.js` and `ltf_entry.js`: symmetric
  fractal swing pivots, HH/HL/LH/LL trend classification, BOS/CHoCH
  detection, and "the last opposite-colored candle before the impulsive
  move that produced the CHoCH" as the Order Block.
- Liquidity (BSL/SSL) + Pending Liquidity markers — swing highs/lows as
  liquidity levels, "swept" when a wick pierces the level without the
  close breaking it (same sweep definition as `ltf_entry.js`).
- Multi-Timeframe Trend table (1m through Daily) — close vs. EMA(50) per
  timeframe, via `request.security` with `lookahead_off` (no repainting).
- ATR-based Stop Loss — real, disclosed formula (`entry ± ATR × multiplier`).
- Information Table — dashboard combining the above.
- Trading Mode — **guidance only** (tooltip suggestions), not a silent
  override. Pine Script indicators cannot change your chart's timeframe,
  and the explicit numeric inputs (pivot lengths, ATR multiplier) are
  always what's actually used — a mode dropdown that silently overrode
  visible inputs would be worse UX than no mode selector at all.

**Deliberately NOT implemented — undocumented/unfalsifiable marketing
claims, not real technical specs:**
- "Dynamic Trend Line" — described only as "proprietary coding," no
  actual formula given. Implementing it would mean inventing a rule and
  presenting it as if it were the referenced tool's, which it wouldn't be.
- "Trading Cycles / Moon Cycle Insights" — ties market phases to lunar
  cycles. No established quantitative basis; this project's own standard
  is to backtest before trusting an idea (see `smc-strategy/README.md`
  and the RSI mean-reversion variant tested earlier for the ORB
  strategy — both came back net losers when actually tested).
- "Volatility Timer" and "AI Optimized SL" — no disclosed methodology.
  The stop-loss need is covered instead by a real, visible ATR calculation.

### Important — relevant prior finding in this repo

`smc-strategy/` already backtested a similar SMC-concept strategy (market
structure + Order Blocks + POI zones, same family of concepts as this
indicator) against real historical data as a fully-automated strategy:
**156 trades, 28.2% win rate, -0.052% avg P&L — a net loser.** That's a
different use case (automated trading vs. this indicator's discretionary
visual-aid role), so it isn't a direct contradiction, but it's relevant
context: this exact family of concepts, mechanically automated, did not
show a real edge when tested with this project's own data. Treat the
zones this indicator draws as discretionary context, not signals to
trade blindly.

### Untested — no Pine Script compiler available in this environment

Every Node.js file in this repo gets syntax-checked (`node --check`) and
often live-tested before being called done. **This file has not been
compiled or run** — there's no Pine Script interpreter available outside
TradingView itself. It was written carefully against known-correct Pine
v6 patterns and reviewed for logic bugs (one real one was caught and
fixed before this README was written: the Trading Mode dropdown was
silently overriding the explicit pivot-length/ATR-multiplier inputs,
making them dead controls — fixed so the explicit inputs always win).
If TradingView's Pine Editor throws a compile error on paste, that's a
real possibility, not a remote one — report the exact error back for a
fix.

### Settings reference

| Group | Setting | What it does |
|---|---|---|
| Trading Mode | Trading Mode | Tooltip guidance only — see above |
| Fair Value Gap | Show Active FVGs, colors, max age | FVG display |
| Order Blocks | Show Swing/Internal OB, pivot lengths, colors | OB detection sensitivity |
| Liquidity | Show BSL/SSL, Show Pending Liquidity, pivot length | Liquidity zone detection |
| Stop Loss | ATR Length, ATR Multiplier | Real ATR-based SL shown in the table |
| Information Table | Show table, position | Dashboard toggle/placement |

## BB Options Strategy — `bb_options_strategy.pine`

Requested against a set of trading notes describing a discretionary
Bollinger Band strategy for stock options: swing entries on the Daily
chart, intraday "bottle neck" squeeze breakouts on 15m/5m, and gap/VWAP
reversal fades. Plots labels directly on the underlying's chart — it
does not price or place trades on the option itself.

### Four setups, each independently toggleable

Labels use plain, unambiguous trading terminology: `BUY` = open long,
`SELL` = close long, `SHORT` = open short, `COVER` = close short. (An
earlier version used just BUY/SELL for everything — a SELL was
genuinely impossible to tell apart from "closing a long" vs. "opening a
short" by reading the chart alone, which caused real confusion reading
a live chart. Fixed.) The setup type and exit reason still drive when a
label fires, they're just not printed in the label text.

1. **Swing** (intended for Daily) — uptrend (20 SMA rising over N bars)
   + pullback that touches the 20 SMA + a green candle → `BUY`. Exit
   (→ `SELL`): a touch of the upper band (target) or a close below the
   20 SMA (stop). Long-only, per the source.
2. **Intraday Breakout / Bottle Neck** (intended for 15m/5m) — Bollinger
   Band width ranks in the bottom X% of its own recent history (the
   squeeze) with below-average volume, then price closes through a band
   → `BUY` (long) or `SHORT`. Exit (→ `SELL`/`COVER`) is band-hugging
   loss, an oversized candle (profit-booking exhaustion), or the
   15-minute trailing stop — whichever fires first.
3. **Reversal** (gap fade) — price gaps meaningfully beyond a band, then
   closes back across VWAP → `BUY`/`SHORT`, exit (`SELL`/`COVER`) at the
   gap extreme.
4. **Trend Continuation** — **not in the source**, added after live
   validation against a real SUZLON chart (2026-07-20, 09:35–10:35)
   showed a genuine gap: a strong ~2.7% continuation rally broke above
   the upper band, above the 20 SMA, and above VWAP, but fired no signal
   at all, because Breakout requires a squeeze in the preceding 5 bars
   and the bands were already wide from the prior day's close — no
   squeeze, so no breakout, even though the price action was real and
   tradeable. This setup fires the same band/SMA/VWAP break as Breakout
   but *without* requiring a prior squeeze, gated instead by
   above-average volume (expansion, not the squeeze's contraction) so it
   doesn't fire on every ordinary band touch. It's mutually exclusive
   with Breakout: if a squeeze DID precede the break, Breakout claims it
   and Continuation stays silent — one move never double-fires two
   entry labels. Same `BUY`/`SHORT`/`SELL`/`COVER` labeling, same exit
   logic (band-hugging loss, extreme-candle exhaustion, 15-minute
   trailing stop) as Breakout.

One more fix worth knowing about: exit conditions used to also get
checked on the very same bar as entry, which meant a strong breakout
candle (large range, which is often *why* it broke out) could trigger
its own extreme-candle exit on the same bar it opened — an
entry-then-immediate-exit that defeated the point of the breakout.
Fixed by skipping the exit check on the entry bar itself.

A second, more consequential fix: **the volume baseline for both the
squeeze filter and Continuation's volume filter was a plain 20-bar
rolling average, which blends across day boundaries.** Live-checking
Continuation against the exact SUZLON case it was built for
(2026-07-20, 09:35–10:35) showed it still didn't fire even after being
built — the 20-bar average sitting around 4M shares/bar while the
actual breakout candles were only 1–2.2M. Root cause: 2026-07-17 traded
111M shares that day vs. 51M on the 20th, and the trailing 20-bar
window at 09:35 (only the 5th bar of the new session) was still mostly
carryover from the 17th's unusually heavy volume, making the filter
nearly impossible to satisfy right after a big-volume day — on *any*
stock, not just this one. Fixed by switching both filters to a
session-scoped volume average that resets each day (the same way VWAP
already does), instead of a plain rolling SMA. Re-verified against the
same SUZLON data after the fix: Continuation now correctly fires at
09:50, `BUY @ 52.45`, inside the box.

Applied the same session-reset principle to Reversal's gap-distance
threshold (`gapATRMult × ATR`) — the shared 14-bar ATR blends in the
prior session's range for roughly the first 70 minutes of a new day,
the same class of issue that broke the volume filters. **Worth being
precise about the difference, though:** the volume fix corrected a
*confirmed* failure (Continuation literally couldn't fire without it).
For Reversal's ATR, re-checking the same SUZLON day found 4 bars where
the session-scoped version disagrees with the old shared-ATR version —
but all 4 are in the afternoon (13:15–15:00), not near the session open
where cross-day contamination would apply (by then the 14-bar window is
entirely within the day's own bars). Those differences are just the
normal, expected gap between a 14-bar rolling average and an all-day
cumulative average — not a demonstrated bug. This one is a *preventive*
consistency fix, applied because the same failure mode is plausible
near a session open on some other stock/day, not because it was caught
actually happening here.

### What was undefined in the source, and how it was operationalized

The notes described several rules in visual/qualitative terms with no
numbers attached. Rather than silently guessing, each was turned into
an explicit, adjustable input (all in the **Exit Rules** and setup input
groups) instead of a hardcoded assumption:

| Undefined in source | Operationalized as | Default |
|---|---|---|
| "Bottle neck" width | BB width's percentile rank vs. its own lookback | bottom 20% of last 100 bars |
| "Decreasing volume" during squeeze | Volume vs. today's session average (resets daily) | < 0.8× average |
| Price "leaves" the band (hugging exit) | Distance from band vs. ATR, for N bars | 0.15×ATR buffer, 1 bar confirm |
| "Exceptionally large candle" | Bar range vs. ATR | > 2.5×ATR |
| Continuation's volume filter *(not in source at all — invented to keep this added setup from over-firing)* | Volume vs. today's session average (resets daily) | > 1.2× average |

(The source's optional "9 EMA early entry" idea was dropped rather than
operationalized — it had no confirmation rule at all, not even an
undefined-but-gesture-at one, so there was nothing real to build. The 9
EMA is still plotted on the chart for visual reference.)

Tune these against what you actually observe on the instruments you
trade — they're inputs, not the source's own numbers (it didn't give any).

### Untested — same caveat as the SMC suite above

Not compiled or run; no Pine interpreter available outside TradingView.
Written against known-correct Pine v6 patterns. One Pine-specific caveat
worth knowing: the 15-minute trailing stop uses `request.security`,
which only returns one sample per bar on your current chart — if you
apply this on a Daily chart (for the Swing setup) while the intraday
exits are also enabled, that trailing stop won't behave as a true
intrabar trail. It's accurate when the chart itself is 15m/5m, which is
what the Breakout and Reversal setups are designed for. If the Pine
Editor throws a compile error on paste, report the exact error back for
a fix.

## BB Intraday Equity Strategy — `bb_intraday_equity.pine`

The intraday-only subset of `bb_options_strategy.pine`, for trading the
equity/stock itself (buy/sell shares) rather than options. Requested
specifically to strip out anything not intraday — so the Swing setup
(Daily chart, held for days, per the source notes) is dropped entirely.
What's left is exactly the source's intraday material:

- **Intraday Breakout / Bottle Neck** (15m/5m) — same squeeze +
  directional-break entry as the options version.
- **Reversal** (gap/VWAP fade) — same gap-then-VWAP-reclaim entry.
- **Trend Continuation** — same not-in-source addition as the options
  version, same squeeze-gap it fills, same volume-expansion filter.
- Same exits: band-hugging loss, extreme-candle exhaustion, 15-minute
  trailing stop.
- Same `BUY`/`SELL`/`SHORT`/`COVER` labeling as the options version, and
  the same same-bar-exit fix — see above.

Functionally these calculations are identical to the corresponding
sections of the options version — the underlying price chart doesn't
change based on whether you click Buy on shares or an option contract.
This file exists so the indicator's input list and status table only
show what's actually relevant when you're not doing swing trades at all.

Same undefined-in-source → operationalized-input table applies (see
above). Same untested caveat applies — not compiled, manually reviewed
only; report the exact compile error if TradingView's editor throws one.
