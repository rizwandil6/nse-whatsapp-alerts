# Multibagger Fundamental Screener

A fundamental-only screen (no technical entry timing) across the **entire
NSE equity universe** (~2,052 real companies, not just the Nifty 500/halal-
353 universe used by the other strategies in this repo), checking 13
requested parameters plus a fresh halal compliance check on every stock.

## Daily rolling scan, not monthly (redesigned after direct feedback)

The original design scanned all ~2,052 stocks once a month — but that's
hours of scraping in one sitting, a real rate-limit risk. Redesigned to
~100 stocks/day via a persisted cursor (`scan_cursor.json`): each day picks
the next slice of the universe, scans just those, and wraps back to the
start once the whole universe has cycled (~21 days). Continuous rolling
freshness instead of one big monthly burst; each day's run takes minutes,
not hours. A stock's qualification status only changes when ITS OWN data
is refreshed (its turn in the ~21-day cycle) — the sector-average PE used
for the Industry PE substitute is recomputed from the full persistent
store every day (a mix of today's-fresh and up-to-21-day-old data), but a
stock's own checks aren't re-evaluated off that drift alone.

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

Plus a **halal recheck** on every stock, every time its turn comes up in
the ~21-day rolling cycle (not just at universe build time): business type
(via Screener.in's own sector taxonomy) and debt-to-assets < 33%.

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

Railway's Trial plan has no persistent volumes, and this state (which
stocks qualify, where the daily cursor is, the forward-performance log)
must survive indefinitely between runs — unlike the daily technical
strategies, where losing in-memory state on a rare restart is a minor,
accepted risk. The only durable option was committing the state files back
to this repo after each run — which means the deployed container holds a
`GITHUB_TOKEN` with write access to this one repo (fine-grained PAT,
Contents: Read and write only). This was a deliberate, explicit decision,
not a default.

**Real bug found and fixed before this ever ran twice**: the deployed
container's git checkout is a fixed build-time snapshot. Without syncing
first, the *second* day's push would be rejected as non-fast-forward the
moment `origin/main` had moved past the container's stale local HEAD —
which it always would, from the very first day's own successful push.
`git_state.js`'s `syncFromRemote()` does a `git fetch` + hard reset to
`origin/main` before reading any state file, every run, fixing this.

## Scale — filtered by ISIN prefix, not name matching

~2,052 real equities (filtered from Upstox's instrument master by ISIN
prefix — `INE` = real company, `INF` = mutual fund/ETF product, verified
directly; an earlier name-based regex attempt wrongly excluded "JETFREIGHT",
a real logistics company, because its name contains the substring "ETF" —
ISIN prefix has no such false-positive risk).

## Forward-performance tracking (the real validation, since backtesting isn't practical)

A historical backtest would need Screener.in to expose historical ratio
snapshots (PE/ROE/PEG at some past date) — it doesn't, only current-moment
values. Instead: `forward_performance_log.json` is a permanent, append-only
log of every QUALIFIED and LOST event (unlike `tracked_multibaggers.json`,
which deletes a symbol once it loses qualification — the log keeps it
forever). Run `node forward_performance.js` to fetch fresh current prices
for every stock ever flagged and see its real price return since
qualification — this is the actual, ongoing evidence for whether the
screen works, accumulating as real time passes rather than reconstructed
from history.

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
- **Sector-average PE mixes fresh and stale data** — on any given day, most
  of `all_results.json` is up to ~21 days old (see the daily-rolling design
  above). Accepted trade-off, not a bug.
- **Not wired to any live execution path.** Alert only — no order placed.

## File guide

| File | Purpose |
|---|---|
| `fetch_universe.js` | Refreshes the ~2,052-stock universe from Upstox's public instrument master |
| `fundamental_screener.js` | Screener.in login + per-stock fetch/parse (11 real parameters + sector tags) |
| `halal_classifier.js` | Business-type exclusion (banks/NBFC/alcohol/tobacco/gambling) from Screener.in's sector taxonomy |
| `scan_multibagger.js` | Daily-batch orchestrator: fetch today's ~100, merge into the persistent store, precompute sector-average PE, check all 13 parameters for today's batch |
| `diff_tracker.js` | New-vs-lost qualification diffing against the persisted tracked list, plus permanent log entries for forward-performance tracking |
| `format_alerts.js` | Telegram message formatting (new-candidate full dump, lost-qualification diff) |
| `git_state.js` | Syncs from `origin/main` before each run, commits/pushes updated state after |
| `forward_performance.js` | Run manually — real price-return report for every stock ever flagged, since qualification |
| `server.js` | Long-running process, triggers one day's batch daily (~20:00-20:30 IST) via a persisted cursor |
| `nse_universe.json` | Current stock universe snapshot (regeneratable) |
| `all_results.json` | Persistent fundamentals store for the whole universe (git-committed, updated incrementally) |
| `scan_cursor.json` | Where the daily rolling scan left off (git-committed) |
| `tracked_multibaggers.json` | Currently-qualifying stocks (git-committed, symbol removed once it loses qualification) |
| `forward_performance_log.json` | Permanent append-only qualification/loss event log (git-committed, never deletes) |
