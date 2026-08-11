CREATE SCHEMA IF NOT EXISTS darvasbox;

-- One unified append-only table for both the real/shadow tracker and the
-- variant (anti-chase, 2% SL) tracker, discriminated by `tracker`. Their
-- event shapes are byte-identical, so a single table with a discriminator
-- beats two near-duplicate tables.
--
-- Dedup is enforced with two PARTIAL unique indexes (not one plain UNIQUE
-- constraint) because EXIT-only columns (action, exit_ts) are NULL on ENTRY
-- rows, and plain UNIQUE treats NULL as never equal to itself -- it would
-- silently let duplicate ENTRY rows through. These indexes are the direct
-- translation of the old file-based eventKey() dedup identity
-- (trade_log.js/variant_log.js), now enforced atomically by the DB instead
-- of a race-prone file read-then-write in one process. This is the actual
-- fix for the 2026-08-11 incident where an unrelated daily commit to `main`
-- triggered a Railway redeploy mid-session, briefly ran two live instances,
-- and each independently wrote its own ENTRY/EXIT for the same trade.
CREATE TABLE IF NOT EXISTS darvasbox.trade_events (
  id                    bigserial PRIMARY KEY,
  tracker               text        NOT NULL,   -- 'real' | 'variant'
  config_tag            text        NOT NULL,
  event_type            text        NOT NULL,   -- ENTRY | EXIT
  symbol                text        NOT NULL,
  direction             text        NOT NULL,   -- LONG | SHORT
  action                text,                   -- EXIT only: EMA_9_20_CROSS | EOD_SQUARE_OFF | CATASTROPHIC_STOP
  entry_ts              timestamptz NOT NULL,
  exit_ts               timestamptz,
  entry_px              numeric,
  theoretical_entry_px  numeric,
  exit_px               numeric,
  theoretical_exit_px   numeric,
  live_price_available  boolean,
  brick_pct             text,
  bars_held             int,
  pnl_pct               numeric,
  payload               jsonb       NOT NULL,
  trade_date            date        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS darvasbox_trade_events_entry_uq
  ON darvasbox.trade_events (tracker, symbol, direction, entry_ts)
  WHERE event_type = 'ENTRY';

CREATE UNIQUE INDEX IF NOT EXISTS darvasbox_trade_events_exit_uq
  ON darvasbox.trade_events (tracker, symbol, direction, action, entry_ts, exit_ts)
  WHERE event_type = 'EXIT';

CREATE INDEX IF NOT EXISTS idx_darvasbox_trade_events_date    ON darvasbox.trade_events (trade_date);
CREATE INDEX IF NOT EXISTS idx_darvasbox_trade_events_tracker ON darvasbox.trade_events (tracker, trade_date);

-- Current open-position snapshot, one row per (tracker, symbol). Upsert
-- (last-writer-wins) is correct here -- this is current state, not a log.
CREATE TABLE IF NOT EXISTS darvasbox.tracked_state (
  tracker     text NOT NULL,
  symbol      text NOT NULL,
  position    jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tracker, symbol)
);
