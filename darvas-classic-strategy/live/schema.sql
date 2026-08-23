-- Classic Darvas Box (weekly) — forward-tracking schema.
-- Isolated in its own `darvas_classic` schema so it can live safely inside
-- an existing shared Postgres database. Idempotent: safe to re-run.

CREATE SCHEMA IF NOT EXISTS darvas_classic;

-- Per-symbol engine state, persisted so the daily job is resumable across
-- restarts/redeploys. One row per symbol; overwritten in place each run.
CREATE TABLE IF NOT EXISTS darvas_classic.symbol_state (
  symbol          text PRIMARY KEY,
  state_json      jsonb       NOT NULL,   -- { confirmedBox, formingBox, position, ... } — see darvas_engine.js
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Raw daily-candle cache per symbol, persisted in Postgres rather than
-- local disk because Railway's filesystem is ephemeral across redeploys --
-- without this, every redeploy would force a full 5-year re-backfill for
-- all 530 symbols before the day's scan could run.
CREATE TABLE IF NOT EXISTS darvas_classic.daily_cache (
  symbol          text PRIMARY KEY,
  daily_bars_json jsonb       NOT NULL,   -- [{date, open, high, low, close, volume}, ...] ascending
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per open/closed position leg-group (a pyramided group of legs that
-- share one trailing stop and exit together — mirrors the backtest ledger).
CREATE TABLE IF NOT EXISTS darvas_classic.trade_events (
  id              bigserial PRIMARY KEY,
  symbol          text        NOT NULL,
  leg_index       int         NOT NULL,       -- 1 = first entry, 2+ = pyramid add
  event_type      text        NOT NULL,       -- ENTRY | STOP_LOSS | TRAIL_STOP | TRAIL_RAISED
  event_date      date        NOT NULL,
  price           numeric     NOT NULL,
  box_top         numeric,
  box_bottom      numeric,
  trail_stop      numeric,
  volume_ratio    numeric,                    -- volume / avg volume at entry, for ENTRY rows
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Audit of what was actually pushed to Telegram (dedupe / idempotency).
CREATE TABLE IF NOT EXISTS darvas_classic.alerts (
  id          bigserial PRIMARY KEY,
  symbol      text,
  alert_type  text        NOT NULL,          -- BOX_CONFIRMED | ENTRY | PYRAMID | TRAIL_RAISED | STOP_LOSS | TRAIL_STOP
  chat_id     text,
  text        text,
  sent_ok     boolean,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_darvas_classic_trade_events_symbol ON darvas_classic.trade_events (symbol);
CREATE INDEX IF NOT EXISTS idx_darvas_classic_trade_events_date ON darvas_classic.trade_events (event_date);
