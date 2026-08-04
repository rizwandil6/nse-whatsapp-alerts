# PDH/PDL Break-&-Retest Scalp — Live Scanner

Live intraday scanner for the **Previous-Day-High / Previous-Day-Low break-&-retest scalp**
on the **halal Nifty-50 subset**. Streams Upstox's V3 market-data WebSocket, detects the setup
in real time, pushes **Telegram** alerts, and logs everything to **PostgreSQL** as a forward-test
dataset.

**Alert-only. This service never places, modifies, or cancels any order.**

Strategy write-up & evidence grade: `wiki/concepts/pdh-pdl-break-retest-scalp.md` (Trading Brain vault).
Pine-script decode it's ported from: `wiki/reference/tws-pdh-pdl-pine-scripts.md`.

---

## What it does

Per symbol, per day:

1. **PDH/PDL** — the prior trading day's high & low are fetched at startup (Upstox daily candles).
2. **ARM** — a **15-min close above PDH → LONG bias** / **below PDL → SHORT bias**, but only if the
   break lands inside the **entry window (09:15–11:45 IST)**. First break of the day wins.
3. **SETUP** — on the **5-min** chart, a **retest** of the broken level confirmed by either:
   - a **one-shot pin bar** (hammer/shooter) — only if price arrived in a clean impulsive leg
     (efficiency ratio ≥ 0.55, approach range ≥ 1.2×ATR, correct direction, level not pre-tagged), or
   - an **engulfing** candle (exempt from the one-shot test).
   Entry = signal-candle close; SL = just beyond the signal candle ± 2 ticks.
4. **TRACK** — virtual milestones **1.5R / 2R / 3R** and **SL / EOD** (15:15 IST force-flat),
   with MFE/MAE in R. One signal per stock per day.

Alerts fire for **ARMED**, **SETUP**, the **1.5R / 2R** milestones, and the **terminal outcome**
(3R / SL / EOD). All go to both configured Telegram chats and are audited in `pdh_pdl.alerts`.

## Universe (29 names)

`live/symbols.json` — the current **Nifty 50 ∩ halal** intersection (symbol → Upstox instrument key),
derived from the vault's `halal-nifty500-universe.json`.

> ⚠️ **Confirm before/while trusting:** Nifty 50 rebalances semi-annually (cut-offs 31 Jan / 31 Jul),
> so membership drifts. This list includes recent halal-eligible additions (MAXHEALTH, ETERNAL) and
> may still contain names that have since been dropped (verify BPCL, HEROMOTOCO). Editing the roster
> is just editing `symbols.json` — no code change.

## Configuration (env vars)

| Var | Purpose | Notes |
|-----|---------|-------|
| `UPSTOX_ACCESS_TOKEN` | Live feed + PDH/PDL fetch | Same daily-refreshed token the other bots use |
| `TELEGRAM_BOT_TOKEN`  | Telegram sends | Same bot token already in `.secrets/telegram_bot_token.txt` |
| `DATABASE_URL`        | Postgres connection string | Or put it in `.secrets/pg_url.txt` for local runs |
| `PGSSL`               | Set to `disable` for a non-SSL Postgres | Default assumes SSL for non-localhost |

Chat IDs are set in `live/streamer.js` (`TELEGRAM_CHAT_IDS`) — personal `5937539323` + group
`-5338709046`, matching the ema-scalp streamer.

**Secrets are never committed** (`.secrets/` is gitignored) and never appear in code — the connection
string and tokens are read at runtime from env / `.secrets`.

## PostgreSQL

Schema lives in `live/schema.sql` and is **auto-created on startup** (idempotent) inside its own
`pdh_pdl` schema — safe to point at an **existing** database. Tables:

- `pdh_pdl.armed` — every 15-min break that armed a bias (base rates)
- `pdh_pdl.signals` — confirmed setups (entry/SL/1.5R/2R/3R/trigger/efficiency)
- `pdh_pdl.outcomes` — 1:1 with a signal, filled live (milestones, final result, R-multiple, MFE/MAE)
- `pdh_pdl.alerts` — audit of every Telegram push

If no connection string is configured, the scanner still streams and alerts — it just skips
persistence and logs a warning.

## Run locally

```bash
cd pdh-pdl-strategy/live
npm install
# put the Postgres URL where the code looks (either works):
#   export DATABASE_URL=postgres://user:pass@host:5432/db
#   echo 'postgres://user:pass@host:5432/db' > ../../.secrets/pg_url.txt
export UPSTOX_ACCESS_TOKEN=...      # a fresh token
export TELEGRAM_BOT_TOKEN=$(cat ../../.secrets/telegram_bot_token.txt)
npm start
```

Run the offline engine self-test (no network/DB needed):

```bash
npm test
```

## Deploy on Railway

This is a **separate Railway service** in the same project (like the other JS live strategies):

1. **New service** → deploy from this repo.
2. **Root directory:** `pdh-pdl-strategy/live`
3. **Start command:** `npm start` (build/install inferred from `package.json`).
4. **Variables:** `UPSTOX_ACCESS_TOKEN`, `TELEGRAM_BOT_TOKEN`, `DATABASE_URL` (+ `PGSSL=disable` if
   your Postgres has no SSL). No Railway Volume needed — Postgres is the store.
5. The process self-heals: it retries with backoff before market open / on an expired token, and
   re-fetches PDH/PDL each day at ~09:10 IST.

## Safety boundary

Read-only market data + alerts only. There is **no order-placement code path** anywhere in this
service. Trading decisions and executions stay entirely manual, in your own broker app.
