CREATE SCHEMA IF NOT EXISTS sabbal;

-- Sabbal Stick (Qutub Minar) 15-min monitor -- independent of the darvasbox
-- schema/tables. One unified append-only table for ENTRY/EXIT events, same
-- shape and same dedup lesson as darvasbox.trade_events (see that schema's
-- comment on the 2026-08-11 dual-instance incident): a Railway redeploy can
-- briefly run two instances, so INSERT ... ON CONFLICT DO NOTHING via a
-- partial unique index is required, not optional.
CREATE TABLE IF NOT EXISTS sabbal.trade_events (
  id           bigserial PRIMARY KEY,
  event_type   text        NOT NULL,   -- ENTRY | EXIT
  symbol       text        NOT NULL,
  direction    text        NOT NULL,   -- LONG | SHORT
  entry_ts     timestamptz NOT NULL,
  exit_ts      timestamptz,
  entry_px     numeric     NOT NULL,
  sl_px        numeric     NOT NULL,
  target_px    numeric     NOT NULL,
  exit_px      numeric,
  exit_reason  text,                   -- TARGET_0.5PCT | STOPLOSS
  pnl_pct      numeric,
  trade_date   date        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sabbal_trade_events_entry_dedup
  ON sabbal.trade_events (symbol, entry_ts)
  WHERE event_type = 'ENTRY';

CREATE UNIQUE INDEX IF NOT EXISTS sabbal_trade_events_exit_dedup
  ON sabbal.trade_events (symbol, entry_ts, exit_ts)
  WHERE event_type = 'EXIT';

-- Current open-position state per symbol, upserted in place. This is what
-- survives a redeploy (Railway's filesystem is ephemeral, Postgres isn't) --
-- on boot the monitor reloads open positions from here instead of starting
-- blind.
CREATE TABLE IF NOT EXISTS sabbal.open_positions (
  symbol      text PRIMARY KEY,
  direction   text        NOT NULL,
  entry_ts    timestamptz NOT NULL,
  entry_px    numeric     NOT NULL,
  sl_px       numeric     NOT NULL,
  target_px   numeric     NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
