package com.adil.nsealerts;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Reads darvas_classic.watchlist -- symbols with a confirmed box but no open
 * position yet, fully replaced (truncate + reinsert) by the daily 17:00 IST
 * scan (see darvas-classic-strategy/live/runner.js). Consumed both by this
 * dashboard tab and by the market-hours intraday watcher
 * (intraday_watcher.js), which Telegram-alerts the moment one actually
 * breaks out on price + volume during the trading day.
 */
@Component
public class DarvasWatchlistService {

    private final JdbcTemplate jdbcTemplate;

    public DarvasWatchlistService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** Closest to trigger first (most negative/least positive distance_pct = nearest or already past). */
    public List<Map<String, Object>> all() {
        return jdbcTemplate.queryForList(
                "SELECT symbol, box_top AS \"boxTop\", box_bottom AS \"boxBottom\", " +
                        "       trigger_price AS \"triggerPrice\", avg_volume AS \"avgVolume\", " +
                        "       last_price AS \"lastPrice\", distance_pct AS \"distancePct\", " +
                        "       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"updatedAt\" " +
                        "FROM darvas_classic.watchlist " +
                        "ORDER BY distance_pct ASC");
    }
}
