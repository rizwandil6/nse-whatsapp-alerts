package com.adil.nsealerts;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Reads the rs_momentum_status table -- one row per symbol, upserted in place by the
 * separate rs-momentum-strategy-live Node service on every status change (ENTRY,
 * ENTRY_PENDING, EXIT, FUNDAMENTALS_CONFIRMED, FUNDAMENTALS_FAILED). Replaces the old
 * append-only rs_momentum_log.json read (GithubJsonStore), which grew a new row per
 * symbol on every daily run instead of updating the existing one.
 */
@Component
public class RsMomentumService {

    private final JdbcTemplate jdbcTemplate;

    public RsMomentumService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** Most-recently-modified first, so a status change (e.g. ENTRY -> EXIT) bumps a
     * symbol back to the top instead of leaving it wherever its first event landed. */
    public List<Map<String, Object>> all() {
        return jdbcTemplate.queryForList(
                "SELECT symbol, company_name AS \"companyName\", status AS \"type\", " +
                        "       to_char(event_date, 'YYYY-MM-DD') AS \"date\", price AS \"price\", " +
                        "       rs_rank_at_entry AS \"rsRankAtEntry\", sales_growth_3y AS \"salesGrowth3Y\", " +
                        "       pnl_pct AS \"pnlPct\", " +
                        "       to_char(modified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"modifiedAt\" " +
                        "FROM rs_momentum_status ORDER BY modified_at DESC");
    }
}
