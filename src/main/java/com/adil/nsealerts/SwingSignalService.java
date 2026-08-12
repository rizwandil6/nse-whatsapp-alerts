package com.adil.nsealerts;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Reads swing.signals -- one row per (symbol, signal_date), upserted in place by
 * the separate swing-strategy/live Node service (trimmed_runner.js / swing_db.js)
 * on its daily 19:00 IST run. Same "Node service writes Postgres, this Java app
 * reads it for the dashboard" pattern as RsMomentumService. The `rules` jsonb is
 * returned as text and JSON.parse()d client-side into the per-rule checklist.
 */
@Component
public class SwingSignalService {

    private final JdbcTemplate jdbcTemplate;

    public SwingSignalService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** Open first, then pending, then closed; within each, newest signal first. */
    public List<Map<String, Object>> all() {
        return jdbcTemplate.queryForList(
                "SELECT symbol, " +
                        "       to_char(signal_date, 'YYYY-MM-DD') AS \"signalDate\", " +
                        "       status, " +
                        "       to_char(entry_date, 'YYYY-MM-DD') AS \"entryDate\", " +
                        "       entry_px AS \"entryPx\", stop_px AS \"stopPx\", " +
                        "       r_per_share AS \"rPerShare\", risk_pct AS \"riskPct\", " +
                        "       target1_px AS \"target1Px\", " +
                        "       to_char(half_date, 'YYYY-MM-DD') AS \"halfDate\", half_price AS \"halfPrice\", " +
                        "       to_char(exit_date, 'YYYY-MM-DD') AS \"exitDate\", " +
                        "       exit_px AS \"exitPx\", r_net AS \"rNet\", " +
                        "       since_alert_pct AS \"sinceAlertPct\", last_price AS \"lastPrice\", " +
                        "       rsi_gate_pass AS \"rsiGatePass\", rules::text AS \"rules\", " +
                        "       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"updatedAt\" " +
                        "FROM swing.signals " +
                        "ORDER BY (status = 'open') DESC, (status = 'pending') DESC, signal_date DESC, symbol");
    }
}
