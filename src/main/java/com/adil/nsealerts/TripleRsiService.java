package com.adil.nsealerts;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Reads triple_rsi.positions -- one row per position (open or closed), written by
 * the separate triple-rsi-strategy/live Node service's daily 16:00 IST run (alert-only,
 * no orders placed -- see that service's README).
 *
 * Scoped to: every position still OPEN today (regardless of entry date -- most were
 * entered before go-live, from the engine's full historical recompute, but are
 * genuinely being tracked/alerted on now) plus any CLOSED position whose ENTRY was on
 * or after LIVE_START_DATE -- i.e. closed trades are included only if they were
 * actually logged from entry onward within the live window, not ones (like an
 * August-entered position that happened to close recently) that were mostly
 * backtest-reconstructed history before ever being live-tracked. Without this filter
 * the dashboard would mix ~1,100 backtest-reconstructed closed trades (back to 2023)
 * in with what's actually live now. 2026-09-01 chosen as the cutoff per explicit
 * request, even though this service's actual first deploy was 2026-09-20 (see
 * [[triple-rsi-forward-data-source]] memory).
 *
 * Also left-joins portfolio.analysis for the fixed 'triple-rsi-auto' system browser_id
 * (see triple-rsi-strategy/live/db.js's syncPortfolioWatchlist, which keeps that
 * watchlist in sync with open positions right after each 16:00 IST run) -- so each
 * open position's latest TradingAgents decision/reasoning (produced by
 * PortfolioAnalysisScheduler's 08:00 IST run) shows up on this tab too, same data
 * the Portfolio tab itself reads via PortfolioService.analysisFor. Closed positions
 * naturally stop getting fresh analysis once syncPortfolioWatchlist removes them from
 * portfolio.tickers, but whatever was last recorded while they were open still shows.
 */
@Component
public class TripleRsiService {

    private static final String PORTFOLIO_SYSTEM_BROWSER_ID = "triple-rsi-auto";
    private static final String LIVE_START_DATE = "2026-09-01";

    private final JdbcTemplate jdbcTemplate;

    public TripleRsiService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** Every open position plus every closed position entered since go-live, open first then most recent entry first, with each symbol's latest TradingAgents take (if any). */
    public List<Map<String, Object>> positions() {
        return jdbcTemplate.queryForList(
                "SELECT p.symbol, p.status, " +
                        "       to_char(p.entry_date, 'YYYY-MM-DD') AS \"entryDate\", " +
                        "       p.entry_price AS \"entryPx\", p.stop_price AS \"stopPx\", " +
                        "       p.bars_held AS \"barsHeld\", p.min_hold_satisfied AS \"minHoldSatisfied\", " +
                        "       p.return_pct AS \"pnlPct\", p.last_price AS \"lastPrice\", " +
                        "       to_char(p.exit_date, 'YYYY-MM-DD') AS \"exitDate\", " +
                        "       p.exit_price AS \"exitPx\", p.exit_reason AS \"exitReason\", " +
                        "       to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"updatedAt\", " +
                        "       to_char(a.analysis_date, 'YYYY-MM-DD') AS \"analysisDate\", " +
                        "       a.decision, a.reasoning " +
                        "FROM triple_rsi.positions p " +
                        "LEFT JOIN LATERAL ( " +
                        "  SELECT analysis_date, decision, reasoning FROM portfolio.analysis " +
                        "  WHERE browser_id = ? AND ticker = p.symbol " +
                        "  ORDER BY analysis_date DESC LIMIT 1 " +
                        ") a ON true " +
                        "WHERE p.status = 'open' OR (p.status = 'closed' AND p.entry_date >= ?::date) " +
                        "ORDER BY (p.status = 'open') DESC, p.entry_date DESC, p.symbol",
                PORTFOLIO_SYSTEM_BROWSER_ID, LIVE_START_DATE);
    }
}
