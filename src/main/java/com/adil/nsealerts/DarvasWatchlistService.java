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
 *
 * LEFT JOINs this week's watchlist_alerts so an already-fired symbol is
 * flagged and sorted first -- confirmed live 2026-08-24: ENTERO fired a real
 * breakout alert but sat at distance_pct 5.1%, rank ~32 of 65, invisible
 * under the dashboard's old top-15 display cap. A symbol that already
 * triggered must never be the one that's hardest to find.
 */
@Component
public class DarvasWatchlistService {

    private final JdbcTemplate jdbcTemplate;

    public DarvasWatchlistService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** Already-alerted symbols first, then closest to trigger. */
    public List<Map<String, Object>> all() {
        return jdbcTemplate.queryForList(
                "SELECT w.symbol, w.box_top AS \"boxTop\", w.box_bottom AS \"boxBottom\", " +
                        "       w.trigger_price AS \"triggerPrice\", w.avg_volume AS \"avgVolume\", " +
                        "       w.last_price AS \"lastPrice\", w.distance_pct AS \"distancePct\", " +
                        "       to_char(w.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"updatedAt\", " +
                        "       (a.symbol IS NOT NULL) AS \"alerted\", " +
                        "       to_char(a.alerted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"alertedAt\", " +
                        "       a.volume_ratio AS \"alertVolumeRatio\" " +
                        "FROM darvas_classic.watchlist w " +
                        "LEFT JOIN darvas_classic.watchlist_alerts a " +
                        "  ON a.symbol = w.symbol " +
                        "  AND a.week_start = (date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata'))::date " +
                        "ORDER BY (a.symbol IS NOT NULL) DESC, w.distance_pct ASC");
    }
}
