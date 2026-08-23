# Classic Darvas Box — Weekly (swing)

Long-only weekly swing strategy over the same 530-stock universe as `swing-strategy/`.
Dashboard-only forward-tracking — no Telegram alerting, no orders are ever placed.
Positions are tracked from **2026-01-01** onward.

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
  dates with no access token, just needs a browser `User-Agent` header), with 429
  retry/backoff.
- `weekly_cache.js` — daily→weekly resampling; daily-candle cache persisted in Postgres
  (`darvas_classic.daily_cache`) since Railway's filesystem is ephemeral across redeploys.
  Backfills 2 years (not the full history) — enough lookback for the 52-week box gate
  ahead of the 2026-01-01 tracking start, while easing rate-limit pressure on the
  unauthenticated endpoint.
- `darvas_engine.js` — pure box/entry/exit state machine, recomputed from full history
  each run (no incremental engine state — avoids drift). Tags every leg of a pyramided
  group with a shared `positionId` so callers can regroup them.
- `db.js` / `schema.sql` — Postgres persistence (`darvas_classic.*` schema): daily
  candle cache + one row per position (open or closed), upserted by `(symbol, entry_date)`.
- `runner.js` — the daily job logic (`runOnce()`): fetch, recompute, filter to
  `entryDate >= 2026-01-01`, upsert. Deterministic full recompute every run, so there's
  no incremental state to drift or reconcile.
- `service.js` — long-running wrapper that self-schedules `runOnce()` once per day
  inside the 17:00–17:10 IST window, same pattern as `swing-strategy/live/service_pg.js`.
  This is the process Railway actually runs (`npm start`). Set `RUN_ONCE=1` to run
  immediately and exit, for local testing.

### Schedule

Self-scheduled daily at **17:00 IST** (see `service.js`) — deploy as a normal Railway
service (`npm start`), not a Cron Job, consistent with the other live strategies in
this repo.

### Environment

- `DATABASE_URL` — reuses the project's shared Postgres (same one `darvasbox-live` and
  `opening-loser-short-live` use), isolated in its own `darvas_classic` schema.
- No `TELEGRAM_BOT_TOKEN`, no `UPSTOX_ACCESS_TOKEN` needed.

### Dashboard tab

`DarvasClassicService.java` reads `darvas_classic.positions` directly; the dashboard
attaches a live LTP to open positions the same way the Swing Strategy tab does
(`SwingLivePriceService`, market-hours only), so P&L on open rows tracks the current
price instead of a frozen snapshot.

### First run

The first run backfills 2 years of daily candles for all 530 symbols (unauthenticated
Upstox REST, 3 concurrent requests with a small per-request stagger + 429 retry/backoff)
— expect it to take a while. Every run after that only re-fetches the last ~10 days per
symbol.
