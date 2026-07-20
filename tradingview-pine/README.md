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
reversal fades. Plots BUY/SELL/EXIT/SL/TARGET labels directly on the
underlying's chart — it does not price or place trades on the option
itself.

### Three setups, each independently toggleable

1. **Swing** (intended for Daily) — uptrend (20 SMA rising over N bars)
   + pullback that touches the 20 SMA + a green candle → `BUY Swing`.
   Exit: `TARGET Swing` on a touch of the upper band, `SL Swing` on a
   close below the 20 SMA.
2. **Intraday Breakout / Bottle Neck** (intended for 15m/5m) — Bollinger
   Band width ranks in the bottom X% of its own recent history (the
   squeeze) with below-average volume, then price closes through a band
   → `BUY`/`SELL Breakout`. Exit is band-hugging loss, an oversized
   candle (profit-booking exhaustion), or the 15-minute trailing stop —
   whichever fires first.
3. **Reversal** (gap fade) — price gaps meaningfully beyond a band, then
   closes back across VWAP → `BUY`/`SELL Reversal`, stop at the gap
   extreme. An optional, purely informational `Early?` marker shows
   where the 9 EMA gets reclaimed ahead of the VWAP cross — it does not
   fire its own trade.

### What was undefined in the source, and how it was operationalized

The notes described several rules in visual/qualitative terms with no
numbers attached. Rather than silently guessing, each was turned into
an explicit, adjustable input (all in the **Exit Rules** and setup input
groups) instead of a hardcoded assumption:

| Undefined in source | Operationalized as | Default |
|---|---|---|
| "Bottle neck" width | BB width's percentile rank vs. its own lookback | bottom 20% of last 100 bars |
| "Decreasing volume" during squeeze | Volume vs. its own 20-bar average | < 0.8× average |
| "9 EMA early entry" | Informational-only marker, not a signal | — (no confirmation rule given) |
| Price "leaves" the band (hugging exit) | Distance from band vs. ATR, for N bars | 0.15×ATR buffer, 1 bar confirm |
| "Exceptionally large candle" | Bar range vs. ATR | > 2.5×ATR |

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
