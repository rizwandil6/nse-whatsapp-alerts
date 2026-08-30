# Inside Candle Sweep+Break — BTCINR/XAUINR/SOLINR/XAGINR (Pi42, alert-only)

Live scanner for the Inside Candle Sweep+Break setup, validated as Pine indicators against
live TradingView data before this port — see
`/Users/adilrizwan/Downloads/second brain/wiki/concepts/inside-candle-liquidity-sweep-scalp.md`
(the strategy writeup, source-confirmed rules) and
`wiki/reference/inside-candle-next-candle-trend-filtered.pine` (the exact Pine version this Node
engine mirrors as of 2026-08-28 — trend-filtered, EMA-based trend + swing-based location; see
`inside-candle-next-candle-sweep-break.pine` for the earlier, simpler untrended version, still
available via `TREND_FILTER_ENABLED=false`).

## The rule

Runs on **multiple signal timeframes concurrently** per symbol (default `15m` + `5m`, see
"Multi-timeframe" below) — everything in this section applies independently on each one.

1. A candle forms whose full range sits inside the immediately preceding same-timeframe candle's
   range ("inside candle").
2. **Trend filter (default ON, see below) gates which candles even arm.** The "mother" candle
   (the one the inside candle sits inside of) must be a swing extreme, and that extreme must line
   up with the current trend: bearish trend + mother at a swing low → pre-commit **LONG**;
   bullish trend + mother at a swing high → pre-commit **SHORT**. Trend/location don't line up →
   the inside candle never arms, no sweep is watched for at all.
3. Check **only the very next candle on that same timeframe**, against the pre-committed direction:
   - Pre-committed LONG: low must breach first, then high breaks → **LONG**, entry = IC high,
     stop = IC low.
   - Pre-committed SHORT: high must breach first, then low breaks → **SHORT**, entry = IC low,
     stop = IC high.
   - Wrong side breaches first, only one side happens, or neither happens → **no trade** —
     cancelled, not retried.
4. **Exit (2026-08-28: floor + EMA trail, see "Floor + EMA trail" below).** `R_TARGET` (default
   **3**, env-overridable) is a *minimum floor*, not a hard exit — source states minimum 1:3,
   sometimes 1:4; reaching it switches the trade into trailing mode instead of closing it.

### Trend filter

Ported from the source's own trend rule (confirmed via NotebookLM re-verification — see
`wiki/concepts/inside-candle-liquidity-sweep-scalp.md`) and mirrors
`wiki/reference/inside-candle-next-candle-trend-filtered.pine` (IC-NextCandle-Trend, v3) exactly:
**trend = close vs. an EMA on that same timeframe** (above = bullish, below = bearish); **location** (is the mother
candle at a swing extreme) is separate, still swing-structure-based over a trailing window. Both
this rule's EMA-based trend and the swing-based location are **this wiki's own codification** of
the source's undefined "look at the chart, a kid could tell you the trend" trend-read, not a
decoded rule. (An earlier HH/HL-vs-LH/LL swing-ladder trend construction was tried first and
scrapped after live debugging showed it going stale/contradictory in ways that didn't match a
naked-eye trend read — see the Pine reference doc's "v2"/"v3" history for the full story.)

- `TREND_FILTER_ENABLED` (env, default **true**/unset) — set to `false` to run the original
  untrended IC-NextCandle behaviour (fires whichever direction the sweep order happens to
  produce, no trend/location gate).
- `EMA_LENGTH` (env, default **9**, was 20 before 2026-08-28) — the EMA (of the tracker's own
  signal-timeframe closes, e.g. 15m closes for the 15m tracker, 5m closes for the 5m tracker)
  that decides trend: close above it = bullish, below = bearish. This same EMA instance also now
  serves as the trail-exit line once a trade reaches its floor (below) — one EMA, two jobs.
- `SWING_LOOKBACK` (env, default **5**) — trailing-bar window for the swing-extreme **location**
  read only (trend itself no longer uses this), matches the commercial indicator's own "Swing
  Pivot Lookback" setting.

Order-of-events within the single next candle is resolved using **1-minute bars streamed
in real time** (`ic_engine.js#addM1Bar`) — the same role `request.security_lower_tf()` plays in
the Pine version.

## Floor + EMA trail (2026-08-28)

`R_TARGET` (default 3R) is a **minimum floor**, not a hard exit. Reaching it doesn't close the
trade — it flips it into **trailing mode**:

- **Phase 1 (before the floor):** fixed stop, fixed floor. Exactly the old behaviour if the floor
  is never reached — hits the floor or the stop, nothing else changes.
- **Phase 2 (trailing, after the floor):** exit is the first **1-minute CLOSE** that crosses back
  against the position through the tracker's own EMA (`EMA_LENGTH`, default 9) — the *same* EMA
  instance the trend gate uses, on the *same* signal timeframe the trade was entered on (a
  5m-entered trade only ever trails the 5m EMA, never 15m's).
- **Stop-loss never trails** — stays fixed at the inside candle's opposite extreme for the whole
  trade, both phases. A trade that touches the floor and then fully reverses can still give back
  to the full -1R stop. Deliberate, confirmed choice, not an oversight — the intent is opening up
  1:6–1:10R potential on strong moves, not building a full ratcheting trailing-stop system.
- **R-multiple on close is now computed from the actual exit price**, not assumed to equal
  `R_TARGET` — real backtest range seen: SL at -1R up to a single trade at **+7.09R**.
- New `inside_candle.outcomes.final_result` value: `TRAIL` (alongside `TARGET`/`SL`). New
  `inside_candle.signals.trailing_active` column persists the phase across restarts (`db.js`'s
  `activateTrailing`, `ic_engine.js`'s `resumeTrade`) — without this, a restart mid-trail would
  incorrectly reset a trade to "waiting to reach the floor" even if price has since pulled back
  below it.
- Telegram: the "reached floor, now trailing" transition is **console-only** (`railway logs`), no
  Telegram ping, to keep alert volume down. SETUP alerts no longer print the
  `Trend-filtered entry (EMA9, swing lookback 5)` parameter line; `Target (3R)` is now labelled
  `Floor (3R min, then trails)`.

## Price source: Mark Price vs Last Price (2026-08-30)

`PRICE_SOURCE` (env, default **`MARK_PRICE`**) controls both history-seed AND live streaming from
a single switch — deliberately one env var, not two, since two independently-set values that must
agree is exactly what caused the 2026-08-26 seed/live mismatch bug. `PRICE_SOURCE=LAST_PRICE`
reverts fully to the original behaviour (REST seed + Pi42's own pre-built `kline` WebSocket topic).

**Why:** a 62-day backtest (after fixing a `pi42_client.js` pagination bug that had silently
truncated history to ~35 days — a page returning fewer than the max bars doesn't mean "end of
history," ordinary small data gaps produce partial pages all the time) showed Mark Price net
**+28.88%** across all six symbols/four timeframes on the identical rule, vs Last Price's
**−29.24%** — broad (23 of 24 symbol-timeframe combos positive on 5m/15m/30m), not one outlier.
Before switching, verified entry/stop/trail-exit price levels computed from Mark Price were
actually **reachable on Last Price** (the real tradeable market) **99%+ of the time**, gaps under
1% when not — so the advantage isn't just an artifact of assuming fills at prices the real market
never touched.

**How live streaming works:** Pi42 has no ready-made Mark Price *candle* topic on its WebSocket —
only `{pair}@markPrice`, a raw tick stream (~1/sec, single price field `p`, confirmed empirically
to match the REST `priceType=MARK_PRICE` kline close exactly). `live/tick_aggregator.js` builds
the same OHLC candles from these ticks that Pi42's own `kline` topic provides for Last Price —
one `TickAggregator` per symbol, tracking every configured timeframe (`1m` + each of
`SIGNAL_TIMEFRAMES`) simultaneously, using the same transition-style rollover detection (a bucket
closes the moment a tick lands in the next one) as the existing kline-based path. Volume is always
0 (`markPriceUpdate` carries no trade-volume field; confirmed Mark Price REST klines report
volume=0 too) — inert, since `ic_engine.js` never reads volume for any decision.

## Multi-timeframe (2026-08-28)

Runs **15m and 5m concurrently per symbol**, each as a fully independent tracker — its own EMA,
its own swing/location state, its own pending-setup state, own entries/exits. They only share the
1-minute bar stream (each needs it separately for intrabar sweep-sequencing).

- `SIGNAL_TIMEFRAMES` (env, comma-separated, default **`15m,5m`**) — which timeframes run. Set to
  e.g. `15m` to go back to single-timeframe, or add more (any interval Pi42's kline API/WebSocket
  supports) as a comma-separated list.
- `DISABLED_ENTRIES` (env, comma-separated `SYMBOL:TF` pairs, default **`SOLINR:5m`**) — a
  per-(symbol, timeframe) kill switch. A disabled tracker still seeds history, watches, logs
  diagnostics, and manages any already-open trade to closure — it just never fires a *new* entry.
  `SOLINR:5m` disabled 2026-08-29 after a 45-day backtest showed a genuine negative edge there
  (13.3% win rate, **-25.37R over 60 trades**) — not just an unlucky live streak, unlike
  BTCINR/XAUINR/XAGINR 5m, which backtested net positive despite similarly low win rates (the
  low-win-rate/big-winner profile this strategy is built around — see "Floor + EMA trail" above).
  SOLINR stays fully enabled on 15m.
- Telegram alerts and dashboard rows are tagged with which timeframe fired (`(15m)`/`(5m)` in the
  message text, a small badge on the dashboard card) so 15m and 5m signals for the same symbol
  never look like the same trade.
- **DB:** `inside_candle.signals.timeframe` (added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  in `schema.sql`, defaults existing rows to `'15m'` since that's the only timeframe that existed
  before this). Restart-resilience (`getOpenSignal`/`abandonOtherOpenSignals` in `db.js`) is scoped
  by **(symbol, timeframe)**, not symbol alone — a symbol can have a genuinely open trade on both
  timeframes at once, and scoping by symbol alone would incorrectly abandon one of them as a
  "stale duplicate" on restart.
- Combined win-rate/P&L stats in Telegram outcome alerts (`db.getStats()`) are deliberately **not**
  split by timeframe — whole-strategy track record, same as before.

## Architecture (mirrors `ichimoku-btc-xau-strategy` exactly)

- `live/pi42_client.js` — public, unauthenticated Pi42 REST client (history seeding + backtest
  paging; `fetchKlinesRange`'s pagination bug fixed 2026-08-30).
- `live/tick_aggregator.js` — builds OHLC candles from Pi42's raw `markPriceUpdate` tick stream
  (`PRICE_SOURCE=MARK_PRICE` path only; unused when `PRICE_SOURCE=LAST_PRICE`).
- `live/ic_engine.js` — per-(symbol, timeframe) state machine (`IcSymbolTracker`, internally
  timeframe-agnostic), emits `SETUP`/`OUTCOME` events tagged with `signalTf`.
- `live/db.js` / `live/schema.sql` — Postgres persistence, own `inside_candle.*` schema, same
  shared instance as every other strategy in this repo.
- `live/streamer.js` — main entry: seeds history via REST, streams live via Pi42's public
  Socket.IO WebSocket (`{symbol}@markPrice` tick stream, or `{symbol}@kline_1m` + one topic per
  `SIGNAL_TIMEFRAMES` entry for `PRICE_SOURCE=LAST_PRICE`), runs one `IcSymbolTracker` per
  (symbol, timeframe) pair, fires Telegram alerts.

## Symbols

`BTCINR`/`XAUINR` — same INR-margined pairs as `ichimoku-btc-xau-strategy` (see that strategy's
README, "Symbol-set switch"), for consistency and to trade directly in INR capital.
`SOLINR`/`XAGINR` added 2026-08-26 (Inside Candle only, not mirrored to Ichimoku).

## Deploy on Railway

Same pattern as every sibling strategy — a **separate Railway service** in the same project:

1. **New service** → deploy from this repo.
2. **Root directory:** `inside-candle-strategy/live`
3. **Start command:** `npm start` (build/install inferred from `package.json`).
4. **Variables:** `TELEGRAM_BOT_TOKEN`, `DATABASE_URL` (+ `PGSSL=disable` if needed), optionally
   `PRICE_SOURCE=LAST_PRICE` to revert from the default Mark Price feed, `R_TARGET` to override
   the default 3R floor, `TREND_FILTER_ENABLED=false` to disable the trend filter (default on),
   `EMA_LENGTH` to override the default 9-period trend+trail EMA, `SWING_LOOKBACK` to override
   the default 5-bar swing window (location only), `SIGNAL_TIMEFRAMES` to override the default
   `15m,5m` timeframe set, `DISABLED_ENTRIES` to override the default `SOLINR:5m` kill-switch list.

## Dashboard

Signals + outcomes surface in the same **Crypto/Forex tab** as Ichimoku, filterable by strategy
(`Ichimoku` / `Inside Candle`) — see `CryptoForexService.java`.

## Safety boundary

Read-only market data + alerts only. There is **no order-placement code path** anywhere in this
service, and no authenticated Pi42 request of any kind — identical boundary to
`ichimoku-btc-xau-strategy`. Trading decisions and executions stay entirely manual, in the user's
own Pi42 account.

## Known limitations / assumptions not yet empirically verified

- **Pi42's `15m`/`5m`/`1m` kline REST + WebSocket topics** are confirmed live for all four symbols
  (verified 2026-08-28 via direct REST calls before deploy; `5m` was already confirmed live via
  `ichimoku-btc-xau-strategy`, same as `30m`/`1h`). Watch the first `[seed]`/`Subscribed:` log
  lines and the first few `kline` events on deploy to confirm the WebSocket side too.
- **Same-1-min-bar-breaches-both-sides edge case** (see `ic_engine.js#addM1Bar`) is treated as no
  signal — a deliberate simplification, not a source-confirmed rule, since order can't be
  determined at 1-min resolution in that case.
- **`tick_aggregator.js` restart-resilience bug, found and fixed live (2026-08-30):** the very
  first production run caught a real false signal (SOLINR:15m) whose `icHigh`/`icLow` exactly
  matched a single 1-minute bar's range instead of a real 15-minute bucket — traced to the
  aggregator's in-memory `forming` state having no persistence across a process restart. Unlike
  `IcSymbolTracker`'s own history (re-seeded from REST via `seedHistory()` on every start), a
  mid-period restart meant the first bucket after reconnect only reflected however many ticks
  arrived post-restart, not the whole period, while still carrying a technically-correct
  timestamp. Fixed: the first bucket per timeframe after every (re)start is now always discarded,
  never emitted — every bucket from the second one onward is guaranteed fully accumulated. Only
  one signal was affected (closed at -1R, small loss, confirmed no other symbol/timeframe hit in
  the same window, nothing was left open).
