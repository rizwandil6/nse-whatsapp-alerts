# Multibagger Fundamental Screener

A fundamental-only screen (no technical entry timing) across the **entire
NSE equity universe** (~2,052 real companies, not just the Nifty 500/halal-
353 universe used by the other strategies in this repo), checking 13
requested parameters plus a fresh halal compliance check on every stock,
every month.

## Parameters checked

| Parameter | Threshold | Source |
|---|---|---|
| Market Cap | > Rs 1,000 Cr | Screener.in top-ratios |
| PEG | < 1 | Derived: PE ÷ Profit Growth 5Y (trailing, not forward-estimate — see limitations) |
| PE vs Industry PE | PE < sector average | Industry PE substitute — see below |
| ROE | > 20% | Screener.in top-ratios |
| ROCE | > 15% | Screener.in top-ratios |
| Debt/Equity | < 0.5 | Derived: Borrowings ÷ Reserves (approximation — see limitations) |
| Promoter holding | > 50% | Screener.in shareholding section |
| Sales Growth 3Y | > 15% | Screener.in "Compounded Sales Growth" table |
| Profit Growth 5Y | > 15% | Screener.in "Compounded Profit Growth" table |
| Pledged % | < 1% | **Unavailable — see limitations. Not counted in the requirement.** |
| OPM | > 15% | Screener.in quarterly results table (latest quarter) |
| Price/Sales | < 10 | Derived: Market Cap ÷ TTM Sales |
| EV/EBITDA | < 25 | Derived: (Market Cap + Debt) ÷ (TTM Sales × OPM%) |

Plus a **halal recheck** on every stock, every month (not just at universe
build time): business type (via Screener.in's own sector taxonomy) and
debt-to-assets < 33%.

## Two parameters needed real substitutes (found by testing, not assumed)

- **Industry PE**: not present anywhere in Screener.in's static HTML for
  any stock tested (TCS, DLF checked directly). May have been removed by
  Screener.in, or is premium-gated. **Substitute**: a homemade sector-
  average PE, computed once per run across the full scanned batch, grouped
  by Screener.in's own "Sector" tag (the same tag used for halal business
  classification).
- **Pledged %**: not present in the static HTML for any tested stock
  (DLF, ZEEL, RPOWER) — loaded via an authenticated AJAX call
  (`Company.showShareholders(...)`) this scraper doesn't replicate, likely
  premium-gated. Returned as `null` and **excluded from the qualification
  requirement entirely** — a stock is never disqualified for this, per
  direct agreement.

## Halal business classification

Uses Screener.in's own 4-level sector taxonomy (Broad Sector → Sector →
Broad Industry → Industry), parsed from the Peer Comparison section.
Verified directly:
- Banks and NBFCs get distinct, keyword-matchable "Industry" tags
  ("Private Sector Bank", "Non Banking Financial Company (NBFC)") even
  though they share the same coarse "Broad Sector" (Financial Services) —
  using the finer tag avoids over-excluding.
- Alcohol ("Breweries & Distilleries") and tobacco ("Cigarettes & Tobacco
  Products") are similarly distinguishable from legitimate FMCG names in
  the same broad sector (e.g. Britannia's "Packaged Foods").
- **Known gap**: gambling/casino operators don't get a clean tag — Delta
  Corp shows as "Amusement Parks/ Other Recreation", indistinguishable by
  keyword from legitimate recreation businesses. Supplemented with a small
  manual denylist (`halal_classifier.js`) rather than silently missing
  these — extend it if more such cases turn up.

## Alerting: alert-once, not recurring

Unlike the daily swing-strategy alerts (fully stateless, re-alerts every
day a signal is present), this maintains a persisted "currently qualifying"
list (`tracked_multibaggers.json`) and only alerts on a **state change**:
- **New candidate found**: a stock that newly satisfies every check.
  Full 13-parameter breakdown sent.
- **Lost qualification**: a previously-alerted stock that no longer
  satisfies one or more checks — including halal-compliance loss
  specifically (debt crossing 33%, or a business reclassification), which
  fires the same alert type, flagged `[HALAL]`. Only the checks that
  changed are shown, with the previous value for comparison.
- Still-qualifying stocks and never-qualifying stocks: silent, by design.

## Why this needs to push to GitHub

Railway's Trial plan has no persistent volumes, and this state must survive
a full month between runs (unlike the daily strategies, where losing
in-memory state on a rare restart is a minor, accepted risk). The only
durable option was committing `tracked_multibaggers.json` back to this repo
after each run — which means the deployed container holds a `GITHUB_TOKEN`
with write access to this one repo (fine-grained PAT, Contents: Read and
write only). This was a deliberate, explicit decision, not a default.

## Scale and runtime — this is NOT a quick check

~2,052 real equities (filtered from Upstox's instrument master by ISIN
prefix — `INE` = real company, `INF` = mutual fund/ETF product, verified
directly; an earlier name-based regex attempt wrongly excluded "JETFREIGHT",
a real logistics company, because its name contains the substring "ETF" —
ISIN prefix has no such false-positive risk).

At a polite scraping pace (avoiding Screener.in rate-limiting — a real risk
at this volume, not hypothetical), a full monthly run takes **hours, not
minutes**. `scan_multibagger.js` checkpoints every 50 stocks
(`raw_fundamentals_checkpoint.json`, gitignored — local/ephemeral only) so
an interrupted run resumes rather than restarting from scratch, as long as
it resumes within the same calendar month; a new month always starts fresh.

## Known limitations

- **Debt/Equity is approximated** as Borrowings ÷ Reserves (no separate
  share-capital row is parsed), not the textbook total-equity denominator.
  Close enough for a threshold screen, not exact.
- **EV/EBITDA ignores cash & equivalents** in the EV calculation (Market
  Cap + Debt, not Market Cap + Debt − Cash) since cash isn't cleanly
  parsed from the balance sheet section currently. A real, minor
  overstatement of EV for cash-rich companies.
- **PEG uses trailing 5-year profit growth**, not forward analyst-estimated
  growth (the textbook PEG denominator) — forward estimates aren't
  available via this free scraping path.
- **~2,052 stocks, not the full BSE+NSE universe** — NSE main-board equities
  only (via Upstox's NSE_EQ segment), matching the halal investing
  constraint's existing scope in this project.
- **Backtest is approximate** (see below) — annual-granularity
  reconstruction, not true point-in-time monthly ratios, since Screener.in
  doesn't expose historical ratio snapshots.
- **Not wired to any live execution path.** Alert only — no order placed.

## File guide

| File | Purpose |
|---|---|
| `fetch_universe.js` | Refreshes the ~2,052-stock universe from Upstox's public instrument master |
| `fundamental_screener.js` | Screener.in login + per-stock fetch/parse (11 real parameters + sector tags) |
| `halal_classifier.js` | Business-type exclusion (banks/NBFC/alcohol/tobacco/gambling) from Screener.in's sector taxonomy |
| `scan_multibagger.js` | Full-batch orchestrator: fetch all, precompute sector-average PE, check all 13 parameters |
| `diff_tracker.js` | New-vs-lost qualification diffing against the persisted tracked list |
| `format_alerts.js` | Telegram message formatting (new-candidate full dump, lost-qualification diff) |
| `git_state.js` | Commits/pushes the updated tracked list back to GitHub |
| `server.js` | Long-running process, triggers the full pipeline on the 1st of each month (IST) |
| `nse_universe.json` | Current stock universe snapshot (regeneratable) |
| `tracked_multibaggers.json` | Persisted qualifying-stocks state (git-committed by the live service, not created here) |
