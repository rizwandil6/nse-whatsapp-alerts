# Classic Darvas Box — Weekly (swing)

Long-only weekly swing strategy over the same 530-stock universe as `swing-strategy/`.
Alert-only forward-tracking — no orders are ever placed.

## Rules

- **Box formation:** a new 52-week high starts a forming box. A week fully contained in
  the box's range counts toward containment; a new high extends the top and resets the
  count; a break of the bottom invalidates the box.
- **Box confirmation:** 3 consecutive contained weeks.
- **Entry:** breakout 1% above the confirmed box top, on volume ≥ 1.5× the trailing
  10-week average (lookback not specified by the source method — documented assumption,
  see `live/darvas_engine.js` header).
- **Initial stop:** 3% below entry.
- **Trailing stop:** raised (never lowered) to each new confirmed box's bottom while the
  position is open.
- **Pyramiding:** every subsequent confirmed box's breakout adds a leg; all legs in a
  group share one trailing stop and exit together.
- **Exit:** a week whose low touches the current trailing stop closes the whole group.
- Long only. No fixed profit target — purely trail-stop-driven.

Full reasoning and a 5-year reference backtest ledger: the "Classic Darvas Box · Weekly
Trade Ledger" artifact (linked in the vault's `darvasbox-forward-data-source` memory /
`wiki/journal/darvasbox-forward-ledger.csv` context).

## Live service (`live/`)

- `symbols.json` — 530 symbols → Upstox instrument keys (same file as `swing-strategy/live/symbols.json`).
- `upstox_fetch.js` — unauthenticated Upstox v2 historical-candle fetch (works for past
  dates with no access token, just needs a browser `User-Agent` header).
- `weekly_cache.js` — daily→weekly resampling; daily-candle cache persisted in Postgres
  (`darvas_classic.daily_cache`) since Railway's filesystem is ephemeral across redeploys.
- `darvas_engine.js` — pure box/entry/exit state machine, recomputed from full history
  each run (no incremental engine state — avoids drift).
- `db.js` / `schema.sql` — Postgres persistence (`darvas_classic.*` schema): daily cache,
  per-symbol state summary (for diffing what's new), trade events, alert log.
- `runner.js` — the daily job. **One-shot** (`node runner.js`, runs once and exits) — meant
  to be invoked by **Railway's Cron Job scheduler**, not a long-running process.

### Schedule

Railway Cron Job, `30 11 * * 1-5` (UTC) = **17:00 IST, Mon–Fri**.

### Environment

- `DATABASE_URL` — reuses the project's shared Postgres (same one `darvasbox-live` and
  `opening-loser-short-live` use), isolated in its own `darvas_classic` schema.
- `TELEGRAM_BOT_TOKEN` — same bot as the other live strategies.
- No `UPSTOX_ACCESS_TOKEN` needed.

### First run

The first run backfills 5 years of daily candles for all 530 symbols (unauthenticated
Upstox REST, ~8 concurrent requests) — expect it to take longer than subsequent
incremental runs. Every run after that only re-fetches the last ~10 days per symbol.
