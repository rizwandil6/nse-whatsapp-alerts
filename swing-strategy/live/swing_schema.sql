-- Confluence Swing Strategy (trimmed rules) — forward-tracking schema.
-- Isolated in its own `swing` schema so it lives safely inside the shared
-- Postgres database (same convention as pdh_pdl.*). Idempotent: safe to
-- re-run on every startup.

CREATE SCHEMA IF NOT EXISTS swing;

-- One row per (symbol, signal_date). The runner recomputes statelessly each
-- day and upserts; status advances pending -> open -> closed over the trade's
-- lifecycle. `rules` holds the per-rule satisfaction detail the dashboard renders.
CREATE TABLE IF NOT EXISTS swing.signals (
  id               bigserial PRIMARY KEY,
  symbol           text        NOT NULL,
  signal_date      date        NOT NULL,          -- daily bar the trigger fired on
  status           text        NOT NULL,          -- pending | open | closed
  entry_date       date,                          -- next session after signal
  entry_px         numeric,
  stop_px          numeric     NOT NULL,          -- zone distal - 0.25*ATR
  r_per_share      numeric,                        -- entry_px - stop_px (1R)
  risk_pct         numeric,                        -- 100 * r_per_share / entry_px
  target1_px       numeric,                        -- entry + 2R (first partial)
  exit_date        date,
  exit_px          numeric,
  r_net            numeric,                        -- realized R after 0.25% costs
  since_alert_pct  numeric,                        -- % move entry -> last_price (open) / -> exit (closed)
  last_price       numeric,                        -- most recent close seen
  rsi_gate_pass    boolean,                        -- would it also pass the full-spec RSI gate?
  rules            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, signal_date)
);

CREATE INDEX IF NOT EXISTS swing_signals_status_idx ON swing.signals (status);
CREATE INDEX IF NOT EXISTS swing_signals_date_idx   ON swing.signals (signal_date DESC);

-- Added for the "half-booked at +2R" event, previously untracked (only the final
-- combined result was visible once a trade fully closed). ALTER, not part of the
-- CREATE TABLE above, since that's a no-op against the already-deployed table.
ALTER TABLE swing.signals ADD COLUMN IF NOT EXISTS half_date  date;
ALTER TABLE swing.signals ADD COLUMN IF NOT EXISTS half_price numeric;
