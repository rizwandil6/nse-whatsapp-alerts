package com.adil.nsealerts;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Reads darvas_classic.positions -- one row per position (open or closed), upserted by
 * the separate darvas-classic-strategy/live Node service (runner.js) on its daily
 * 17:00 IST run. Same "Node service writes Postgres, this Java app reads it for the
 * dashboard" pattern as SwingSignalService. Dashboard-only tracking (positions from
 * 2026-01-01 onward) -- no Telegram alerting on the Node side.
 */
@Component
public class DarvasClassicService {

    private final JdbcTemplate jdbcTemplate;

    public DarvasClassicService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** Open first, then closed; within each, newest entry first. */
    public List<Map<String, Object>> all() {
        return jdbcTemplate.queryForList(
                "SELECT symbol, " +
                        "       to_char(entry_date, 'YYYY-MM-DD') AS \"entryDate\", " +
                        "       entry_price AS \"entryPx\", status, legs, legs_json::text AS \"legsJson\", " +
                        "       trail_stop AS \"stopPx\", " +
                        "       to_char(exit_date, 'YYYY-MM-DD') AS \"exitDate\", " +
                        "       exit_price AS \"exitPx\", exit_reason AS \"exitReason\", pnl_pct AS \"pnlPct\", " +
                        "       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"updatedAt\" " +
                        "FROM darvas_classic.positions " +
                        "ORDER BY (status = 'open') DESC, entry_date DESC, symbol");
    }
}
