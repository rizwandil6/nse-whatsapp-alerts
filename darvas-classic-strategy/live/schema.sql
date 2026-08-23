-- Classic Darvas Box (weekly) — forward-tracking schema.
-- Isolated in its own `darvas_classic` schema so it can live safely inside
-- an existing shared Postgres database. Idempotent: safe to re-run.

CREATE SCHEMA IF NOT EXISTS darvas_classic;

-- Superseded by darvas_classic.positions below (2026-08-23): the old
-- diff-and-Telegram-alert design needed a per-symbol counter to detect
-- "what's new since last run"; alerting was dropped in favor of a plain
-- dashboard P&L view (like Swing Strategy), so the whole diff mechanism --
-- and the bad data from the first run's alert-flood incident -- goes with it.
DROP TABLE IF EXISTS darvas_classic.alerts;
DROP TABLE IF EXISTS darvas_classic.trade_events;
DROP TABLE IF EXISTS darvas_classic.symbol_state;

-- One row per position (a pyramided group of legs sharing one trailing
-- stop), open or closed. Fully recomputed and upserted every run --
-- deterministic from the weekly bar history, so there's no drift to
-- reconcile. Mirrors swing.signals' shape closely so the dashboard tab can
-- follow the same rendering pattern.
CREATE TABLE IF NOT EXISTS darvas_classic.positions (
  id              bigserial PRIMARY KEY,
  symbol          text        NOT NULL,
  entry_date      date        NOT NULL,   -- first leg's entry date -- the position's natural key together with symbol
  entry_price     numeric     NOT NULL,   -- first leg's entry price
  status          text        NOT NULL,   -- open | closed
  legs            int         NOT NULL,
  legs_json       jsonb       NOT NULL,   -- [{legIndex, entryDate, entryPrice, boxTop}, ...]
  trail_stop      numeric,
  exit_date       date,
  exit_price      numeric,
  exit_reason     text,                   -- STOP_LOSS | TRAIL_STOP
  last_price      numeric,                -- open rows only: most recent weekly close seen, as a baseline before any live-price refresh
  pnl_pct         numeric,                -- realized (closed) or baseline-computed (open, refreshed with live price by the dashboard during market hours) vs entry_price
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, entry_date)
);

-- Raw daily-candle cache per symbol, persisted in Postgres rather than
-- local disk because Railway's filesystem is ephemeral across redeploys --
-- without this, every redeploy would force a full re-backfill for all 530
-- symbols before the day's scan could run.
CREATE TABLE IF NOT EXISTS darvas_classic.daily_cache (
  symbol          text PRIMARY KEY,
  daily_bars_json jsonb       NOT NULL,   -- [{date, open, high, low, close, volume}, ...] ascending
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_darvas_classic_positions_status ON darvas_classic.positions (status);

-- Migration: the table above already existed without last_price (added 2026-08-23)
-- when this scanner first went live -- ALTER is needed on top of CREATE TABLE IF NOT
-- EXISTS since that clause is a no-op once the table exists.
ALTER TABLE darvas_classic.positions ADD COLUMN IF NOT EXISTS last_price numeric;
