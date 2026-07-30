# Williams %R Strategy — Live Service

Live (paper) tick-WebSocket version of ONE deliberate combo backtested in
`renko-python-backtest/williams_r_backtest.py`: period=14,
oversold=-90/overbought=-10, confirm_n=2, **no stop-loss**, on 5-minute
candles, across the real 21-holding portfolio (`renko-python-backtest/holdings.csv`).
That combo returned 13 trades, 84.6% win rate, +₹1,492 on a same-day
backtest (2026-07-30) — not the single best combo tested that day, but the
one explicitly chosen to go live.

## Strategy (exact port of `run_backtest()`, not a simplification)

- **LONG entry**: %R crosses below -90 → watch for confirmation on a LATER
  bar (never the crossing bar itself) → confirmed by EITHER 2 consecutive
  upward %R ticks while still below -90, OR a single bullish bar
  (close>open) with a higher low than the prior bar → position opens at
  the NEXT bar's open (no lookahead).
- **LONG exit**: %R crosses above -10 — the SAME value that triggers a
  SHORT entry. Full oversold-to-overbought round trip, not a return to
  neutral.
- **SHORT entry/exit**: exact mirror at the overbought/oversold boundary.
- **No stop-loss of any kind** — a losing trade rides until the opposite
  %R threshold, however long that takes.

## Key architectural difference from every other `live/` service here

**No daily reset, no forced EOD square-off.** The backtest itself doesn't
day-scope trades — a position can span multiple days, even weekends — so
this doesn't either. That means, unlike DarvasBox (rebuilds its tracker
fresh every morning) or RS-momentum (pure daily batch, no live ticks at
all), this service's **open position and in-progress watch-state must
survive a restart**, not just reset daily. See `tracked_state.js` /
`git_state.js` — a persisted `tracked_williams_r.json` (per-symbol
position + watch flags + streaks + `lastProcessedTimestampMs`) makes a
restart resume exactly where it left off, restored via
`WilliamsRLiveTracker.fromJSON`.

`oneMinBars[symbol]` is a single, never-daily-reset growing array
(periodically trimmed to a trailing ~45-day window purely to bound
memory, unrelated to any day boundary), and the 5-min bar series is
recomputed fresh from it via `aggregateTo5MinMultiDay` on every new bar —
simpler and safer than DarvasBox's historical-prefix + today's-growing-
suffix split (that split was an optimization DarvasBox needed for its own
reasons; recomputing the whole, modest-sized 5-min series every 1-5
minutes is cheap enough here not to bother).

A **first-ever run** for a symbol (no persisted state) pre-seeds
`lastProcessedTimestampMs` to the last bar strictly before today, so
historical warm-up bars silently feed %R's rolling window without
generating alerts — the strategy starts watching cleanly from deployment
day, since there's no genuine prior "watching" state to preserve on a
brand-new deploy. A **restart with existing persisted state** processes
everything since `lastProcessedTimestampMs` normally (alerts fire for any
real gap catch-up), matching every other `live/` service's reconnect
convention.

## Same infrastructure as the sibling live/ services (copied, not required cross-directory)

`bar_aggregator.js`, `tick_bar_builder.js`, `MarketDataFeedV3.proto` are
verbatim copies of `renko-8-indicators/live-darvasbox-shadow`'s (Upstox
WebSocket auth/protobuf/1-min-bar-building logic is identical across every
strategy in this repo). `github_contents.js` includes the >1MB
Contents-API-doesn't-inline-content fallback fix (confirmed production bug,
2026-07-27) from day one.

## File guide

| File | Purpose |
|---|---|
| `williams_r_tracker.js` | The strategy itself — entry/exit/watch/confirm state machine, LTP-confirmed pricing, `toJSON`/`fromJSON` persistence |
| `streamer.js` | WebSocket connect/auth/reconnect, 1-min bar building, startup history fetch + seeding, stale-connection watchdog |
| `trade_log.js` | Local ENTRY/EXIT event log + dedup (prevents re-alerting a replayed event) |
| `tracked_state.js` | Local read/write of per-symbol tracker state |
| `git_state.js` | Single-commit GitHub REST API state sync/push (both state files bundled together) |
| `bar_aggregator.js` | IST time helpers + 5-min bar aggregation (copied) |
| `tick_bar_builder.js` | Builds 1-min OHLCV bars from raw ticks (copied) |
| `symbols.json` | 21-symbol instrument-key map (holdings.csv's real portfolio) |
| `tracked_williams_r.json` | Per-symbol position/watch state (git-committed) |
| `williams_r_trade_log.json` | Permanent entry/exit log (git-committed, never deletes) |

## Env vars required

`UPSTOX_ACCESS_TOKEN`, `GITHUB_TOKEN`, and optionally `TELEGRAM_BOT_TOKEN`
(+ `WILLIAMS_R_TELEGRAM_CHAT_IDS`, `WILLIAMS_R_TELEGRAM_ENABLED`).

## Not yet deployed

Built and unit-tested (`node --test *.test.js`) locally. Railway service
creation/deploy is a separate, explicit step — not done as part of the
build.
