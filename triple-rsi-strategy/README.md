# Triple RSI Strategy

Long-only daily mean-reversion strategy over the halal-500 universe. Full research,
backtests, and reasoning live in the vault:
`second brain/wiki/concepts/triple-rsi-strategy.md`. This folder is the **live alert
service** — no dashboard tab, no orders, Telegram alerts only.

## Rules (canonical config, locked in 2026-09-19/20)

- **Entry — buy at the close when all of the following are true:**
  1. RSI(5) < 30
  2. RSI(5) down 3 days running
  3. RSI(5) was < 60 three trading days ago
  4. Close > 200-day MA
  5. Close is at least 15% above the 200-day MA
- **Exit:** sell at the close when RSI(5) crosses above 50 — but not before 7 trading
  days have passed since entry. A 15% stop-loss can fire at any time, including before
  day 7, and always takes priority over the RSI exit.

Backtested (halal-500, 2023-09-19..2026-09-19): 1,031 trades, 66.5% win rate, +1.86%
avg return/trade, profit factor 1.85. Every parameter above was chosen by testing
alternatives (5/8/10/15% stops, no min hold, no distance filter, next-day-open entry,
a market-crash exit override, a full-NSE universe expansion) against this config — see
the wiki page for the full ablation history before changing any of it.

## Execution model — why AMO, not same-day MOC

The backtested numbers assume entry **at the signal day's own close**, which needs a
Market-on-Close order placed before 15:30 IST. This service scans **after** close
(16:00 IST, see below), so it cannot place same-day MOC orders — instead, an entry
alert means **place an AMO to buy at tomorrow's open**. This was separately backtested
(`wiki/concepts/triple-rsi-strategy.md`, "Next-day open entry" section): modestly
worse than same-day-close (roughly 1.5-2pp lower win rate), not a different strategy —
a small, known, accepted cost of practical execution.

## Live service (`live/`)

- `symbols.json` — 353 halal-500 symbols → Upstox instrument keys (copied from the
  vault's `wiki/comparisons/assets/halal-nifty500-universe.json` — same universe used
  for every backtest on this strategy; NOT the extended/full-NSE universes the vault
  also tested and rejected).
- `upstox_fetch.js` — unauthenticated Upstox v2 historical-candle fetch (no access
  token needed for past dates; browser `User-Agent` header required), with 429
  retry/backoff. Same file as the other live strategies in this repo.
- `daily_cache.js` — daily-candle backfill (2 years) + incremental top-up, persisted
  in Postgres (`triple_rsi.daily_cache`) since Railway's filesystem is ephemeral
  across redeploys. Same pattern as `darvas-classic-strategy/live/weekly_cache.js`,
  minus the weekly resampling (this strategy runs on daily bars directly).
- `triple_rsi_engine.js` — pure signal engine: Wilder RSI(5), 200-day SMA, the full
  entry/exit state machine (min hold + stop-loss priority). Recomputes the full trade
  history from scratch on every call, no incremental state — deterministic from the
  daily bar history, so nothing can drift.
- `db.js` / `schema.sql` — Postgres persistence (`triple_rsi.*` schema): daily candle
  cache + one row per position (open or closed), upserted by `(symbol, entry_date)`,
  plus `entry_alerted`/`exit_alerted` dedupe flags.
- `runner.js` — the daily job (`runOnce()`): fetch, recompute, upsert, and alert.
  **Alerts fire ONLY for events dated today** (`entry_date === today` or
  `exit_date === today`) — a full 2-year recompute can otherwise surface many
  long-past trades as "new" on the first run and flood Telegram (this exact failure
  mode is documented in `darvas-classic-strategy/live/schema.sql`'s history; this
  service is built to avoid it from day one, not fix it after the fact).
- `service.js` — long-running wrapper that self-schedules `runOnce()` once per day
  inside the **16:00–16:10 IST** window (well after the 15:30 close, so the day's bar
  is settled). This is the process Railway actually runs (`npm start`). Set
  `RUN_ONCE=1` to run the scan immediately and exit, for local testing.
- `telegram.js` — minimal sender, same chat IDs as the other live bots in this repo.

### Alerts sent

- **New entry signal** (once, the day it's confirmed): ticker, entry close, computed
  stop price, and an explicit "place an AMO for tomorrow's open" instruction.
- **Position closed** (once, the day it happens): ticker, entry/exit dates and prices,
  exit reason (`15% stop-loss` or `RSI(5) > 50`), realized return, days held.
- Nothing else. No daily digest, no dashboard — this is intentionally minimal.

### What this service will NEVER do

Per the 2026-09-20 decision: **alert-only, no auto-execution.** This service does not
call any order-placement API, Kite or otherwise. If you want to automate execution
later, that is a deliberate, separate decision to make explicitly — do not wire order
placement into `runner.js` without re-deciding this.

### Schedule

Self-scheduled daily at **16:00 IST** (see `service.js`) — deploy as a normal Railway
service (`npm start`), not a Cron Job, consistent with the other live strategies in
this repo.

### Environment

- `DATABASE_URL` — reuses the project's shared Postgres (same one the other live
  strategies use), isolated in its own `triple_rsi` schema.
- `TELEGRAM_BOT_TOKEN` — same bot as the other live strategies in this repo.
- No `UPSTOX_ACCESS_TOKEN` needed — historical daily candles are unauthenticated.

### First run

The first run backfills 2 years of daily candles for all 353 symbols (unauthenticated
Upstox REST, 3 concurrent requests with a small per-request stagger + 429
retry/backoff) — expect it to take a while, and expect **zero alerts** even if the
backfill surfaces open/closed positions in the history (the same-day alert gate in
`runner.js` suppresses all of it; only today's events ever alert). Every run after
that only re-fetches the last ~10 days per symbol and is fast.

### Local testing

```bash
cd triple-rsi-strategy/live
npm install
RUN_ONCE=1 node service.js
```

Without `DATABASE_URL` set, this runs against a local JSON cache
(`daily_cache_store.json`, gitignored) and logs every alert it *would* send instead of
requiring Postgres — useful for a dry run before wiring up the real database.
