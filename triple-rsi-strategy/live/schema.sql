-- Triple RSI Strategy — forward-tracking + alert schema.
-- Isolated in its own `triple_rsi` schema so it can live safely inside the
-- existing shared Postgres database used by the other live bots in this repo.
-- Idempotent: safe to re-run.

CREATE SCHEMA IF NOT EXISTS triple_rsi;

-- Raw daily-candle cache per symbol, persisted in Postgres rather than local
-- disk because Railway's filesystem is ephemeral across redeploys -- without
-- this, every redeploy would force a full re-backfill for all 353 symbols
-- before the day's scan could run.
CREATE TABLE IF NOT EXISTS triple_rsi.daily_cache (
  symbol          text        PRIMARY KEY,
  daily_bars_json jsonb       NOT NULL,   -- [{date, open, high, low, close, volume}, ...] ascending
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per position (open or closed), fully recomputed and upserted every
-- run -- deterministic from the daily bar history (triple_rsi_engine.js has
-- no incremental state), so there's no drift to reconcile.
CREATE TABLE IF NOT EXISTS triple_rsi.positions (
  id                bigserial   PRIMARY KEY,
  symbol            text        NOT NULL,
  entry_date        date        NOT NULL,
  entry_price       numeric     NOT NULL,
  stop_price        numeric     NOT NULL,   -- entry_price * 0.85
  status            text        NOT NULL,   -- open | closed
  bars_held         int         NOT NULL,
  min_hold_satisfied boolean    NOT NULL DEFAULT false,  -- open rows only: bars_held >= 7
  exit_date         date,
  exit_price        numeric,
  exit_reason       text,                   -- stop | rsi
  return_pct        numeric,                -- realized (closed) or unrealized-as-of-last-run (open)
  last_price        numeric,                -- open rows only: most recent close seen
  entry_alerted     boolean     NOT NULL DEFAULT false,  -- Telegram dedupe: has the entry alert been sent?
  exit_alerted      boolean     NOT NULL DEFAULT false,  -- Telegram dedupe: has the exit alert been sent?
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, entry_date)
);

CREATE INDEX IF NOT EXISTS idx_triple_rsi_positions_status ON triple_rsi.positions (status);

-- One row per (symbol, day) for currently OPEN positions only -- a daily history of
-- day-over-day price move + that day's TradingAgents verdict (portfolio.analysis,
-- browser_id='triple-rsi-auto', see db.js's syncPortfolioWatchlist), so both are kept
-- even after portfolio.tickers/analysis rows get overwritten or the position closes.
-- Written once per symbol per 16:00 IST run, right after that position's own upsert.
CREATE TABLE IF NOT EXISTS triple_rsi.daily_snapshots (
  symbol           text        NOT NULL,
  snapshot_date    date        NOT NULL,   -- the daily bar's own date (the day this % change is for)
  day_change_pct   numeric,                -- (close - prevClose) / prevClose * 100, from that day's bar
  ta_decision      text,                   -- portfolio.analysis.decision as of this run, if analyzed yet
  ta_analysis_date date,                   -- which day's TradingAgents run produced that decision
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_triple_rsi_daily_snapshots_symbol ON triple_rsi.daily_snapshots (symbol, snapshot_date DESC);
