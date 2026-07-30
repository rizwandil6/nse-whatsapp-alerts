-- Quarterly results log, scoped Postgres addon (2026-07-30) -- see
-- application.yml's datasource comment for why this is the one log that
-- moved off the GitHub-JSON-branch pattern the rest of the project uses.
--
-- (symbol, quarter_label) is UNIQUE: an announcement can get reprocessed
-- (retry, redeploy replay) and this must be idempotent -- an upsert on that
-- key, not an append -- unlike the JSON logs elsewhere in this project,
-- which have had real duplicate-row incidents from exactly this kind of
-- replay (see rs-momentum-strategy's/darvasbox's own trade-log duplicate
-- fixes). revenue is never negative so only net profit needs a swing_type
-- (a company can flip between a loss and a profit; revenue can't go
-- negative the same way) -- swing_type is set instead of a misleading/
-- undefined YoY % whenever the sign of net profit differs between this
-- quarter and the same quarter last year.
CREATE TABLE IF NOT EXISTS quarterly_results (
    id                    BIGSERIAL PRIMARY KEY,
    symbol                TEXT NOT NULL,
    company_name          TEXT,
    quarter_label         TEXT NOT NULL,      -- e.g. "Mar 2026", exactly as shown on Screener.in
    quarter_end_date      DATE,               -- best-effort parse of quarter_label; NULL if unparseable
    revenue_cr            NUMERIC,
    net_profit_cr         NUMERIC,
    revenue_yoy_cr        NUMERIC,            -- same quarter_label, prior year -- NULL if not found on the page
    net_profit_yoy_cr     NUMERIC,
    revenue_yoy_pct       NUMERIC,            -- NULL when revenue_yoy_cr is NULL (no prior-year data)
    net_profit_yoy_pct    NUMERIC,            -- NULL when net_profit_yoy_cr is NULL OR profit_swing_type is set
    profit_swing_type     TEXT,               -- 'LOSS_TO_PROFIT' | 'PROFIT_TO_LOSS' | NULL for a normal same-sign comparison
    announcement_category TEXT,               -- NSE category the triggering announcement was filed under
    announcement_date     TIMESTAMPTZ NOT NULL,
    source_link           TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT quarterly_results_symbol_quarter_uniq UNIQUE (symbol, quarter_label)
);

CREATE INDEX IF NOT EXISTS idx_quarterly_results_announcement_date
    ON quarterly_results (announcement_date DESC);
