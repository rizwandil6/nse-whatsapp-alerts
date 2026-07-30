package com.adil.nsealerts;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/**
 * Computes the YoY comparison (this quarter vs. the SAME quarter a year ago,
 * matched by exact quarter-end date -- not a fragile "4 columns back"
 * positional assumption, since a gap in Screener's series would silently
 * misalign that) and upserts one row into Postgres's quarterly_results
 * table. Only called for announcements FundamentalScreener actually found a
 * non-empty quarterly series for -- see AlertPoller's category filter for
 * why this isn't attempted on every announcement, unlike the existing
 * Sales-Growth-3Y screening fetch.
 */
@Component
public class QuarterlyResultsService {
    private static final Logger logger = LoggerFactory.getLogger(QuarterlyResultsService.class);

    private final JdbcTemplate jdbcTemplate;

    public QuarterlyResultsService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void recordIfAvailable(String symbol, String companyName, FundamentalResult fr,
                                   String announcementCategory, OffsetDateTime announcementDate, String sourceLink) {
        if (fr == null) return;
        List<String> labels = fr.getQuarterLabels();
        List<LocalDate> dates = fr.getQuarterEndDates();
        if (labels.isEmpty() || dates.isEmpty()) {
            logger.debug("[QuarterlyResults] {}: no quarter labels/dates parsed -- skipping", symbol);
            return;
        }

        int lastIdx = labels.size() - 1;
        String quarterLabel = labels.get(lastIdx);
        LocalDate quarterEndDate = dates.get(lastIdx);
        Double revenueCr = valueAt(fr.getQuarterlyRevenueCrFull(), lastIdx);
        Double netProfitCr = valueAt(fr.getQuarterlyNetProfitCrFull(), lastIdx);

        if (revenueCr == null && netProfitCr == null) {
            logger.debug("[QuarterlyResults] {}: latest quarter ({}) has neither revenue nor profit -- skipping", symbol, quarterLabel);
            return;
        }

        Integer yoyIdx = quarterEndDate != null ? findYoyIndex(dates, quarterEndDate) : null;
        Double revenueYoyCr = yoyIdx != null ? valueAt(fr.getQuarterlyRevenueCrFull(), yoyIdx) : null;
        Double netProfitYoyCr = yoyIdx != null ? valueAt(fr.getQuarterlyNetProfitCrFull(), yoyIdx) : null;

        Double revenueYoyPct = yoyPct(revenueCr, revenueYoyCr); // revenue is never negative -- no swing case needed
        String profitSwingType = profitSwingType(netProfitCr, netProfitYoyCr);
        Double netProfitYoyPct = profitSwingType == null ? yoyPct(netProfitCr, netProfitYoyCr) : null;

        upsert(symbol, companyName, quarterLabel, quarterEndDate, revenueCr, netProfitCr,
                revenueYoyCr, netProfitYoyCr, revenueYoyPct, netProfitYoyPct, profitSwingType,
                announcementCategory, announcementDate, sourceLink);
    }

    /** Backs the dashboard's Quarterly Results tab -- most recently ANNOUNCED first (not most recent quarter), so a
     * results season shows up in the order companies actually filed, matching every other tab's "recent activity" framing. */
    public List<Map<String, Object>> recentResults(int limit) {
        // Aliased to camelCase -- queryForList's Map keys are exactly the column/alias
        // names, and every other dashboard tab's JSON is camelCase (Jackson doesn't
        // auto-convert snake_case for a plain Map the way it would for an @Entity).
        return jdbcTemplate.queryForList(
                "SELECT symbol, company_name AS \"companyName\", quarter_label AS \"quarterLabel\", " +
                        "       quarter_end_date AS \"quarterEndDate\", revenue_cr AS \"revenueCr\", " +
                        "       net_profit_cr AS \"netProfitCr\", revenue_yoy_cr AS \"revenueYoyCr\", " +
                        "       net_profit_yoy_cr AS \"netProfitYoyCr\", revenue_yoy_pct AS \"revenueYoyPct\", " +
                        "       net_profit_yoy_pct AS \"netProfitYoyPct\", profit_swing_type AS \"profitSwingType\", " +
                        "       announcement_category AS \"announcementCategory\", " +
                        // Cast to text explicitly -- java.sql.Timestamp's default Jackson
                        // serialization isn't worth relying on sight-unseen; this guarantees
                        // the same "YYYY-MM-DDTHH:MM:SS..." shape fmtTime() on the dashboard
                        // already parses for every other tab's date field.
                        "       to_char(announcement_date AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"announcementDate\", " +
                        "       source_link AS \"sourceLink\" " +
                        "FROM quarterly_results ORDER BY announcement_date DESC LIMIT ?",
                limit);
    }

    /** Exact date match, one year earlier -- the whole point of using data-date-key dates instead of a positional offset.
     * Package-private (not private) so QuarterlyResultsServiceTest can exercise the pure calc logic directly. */
    Integer findYoyIndex(List<LocalDate> dates, LocalDate quarterEndDate) {
        LocalDate target = quarterEndDate.minusYears(1);
        for (int i = 0; i < dates.size(); i++) {
            if (target.equals(dates.get(i))) return i;
        }
        return null;
    }

    private Double valueAt(List<Double> series, int idx) {
        return idx >= 0 && idx < series.size() ? series.get(idx) : null;
    }

    String profitSwingType(Double current, Double yoy) {
        if (current == null || yoy == null) return null;
        boolean currentLoss = current < 0;
        boolean yoyLoss = yoy < 0;
        if (currentLoss == yoyLoss) return null; // same sign (or both exactly zero) -- a normal % comparison applies
        return yoyLoss ? "LOSS_TO_PROFIT" : "PROFIT_TO_LOSS";
    }

    /** Uses abs(yoy) as the denominator so the SIGN of the result always means "better/worse than a year ago",
     * even when yoy itself was negative (a loss narrowing from -100 to -50 is a +50% improvement, not -50%). */
    Double yoyPct(Double current, Double yoy) {
        if (current == null || yoy == null || yoy == 0) return null;
        return (current - yoy) / Math.abs(yoy) * 100.0;
    }

    private void upsert(String symbol, String companyName, String quarterLabel, LocalDate quarterEndDate,
                         Double revenueCr, Double netProfitCr, Double revenueYoyCr, Double netProfitYoyCr,
                         Double revenueYoyPct, Double netProfitYoyPct, String profitSwingType,
                         String announcementCategory, OffsetDateTime announcementDate, String sourceLink) {
        try {
            jdbcTemplate.update(
                    "INSERT INTO quarterly_results " +
                            "(symbol, company_name, quarter_label, quarter_end_date, revenue_cr, net_profit_cr, " +
                            " revenue_yoy_cr, net_profit_yoy_cr, revenue_yoy_pct, net_profit_yoy_pct, profit_swing_type, " +
                            " announcement_category, announcement_date, source_link) " +
                            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
                            "ON CONFLICT (symbol, quarter_label) DO UPDATE SET " +
                            "  company_name = EXCLUDED.company_name, quarter_end_date = EXCLUDED.quarter_end_date, " +
                            "  revenue_cr = EXCLUDED.revenue_cr, net_profit_cr = EXCLUDED.net_profit_cr, " +
                            "  revenue_yoy_cr = EXCLUDED.revenue_yoy_cr, net_profit_yoy_cr = EXCLUDED.net_profit_yoy_cr, " +
                            "  revenue_yoy_pct = EXCLUDED.revenue_yoy_pct, net_profit_yoy_pct = EXCLUDED.net_profit_yoy_pct, " +
                            "  profit_swing_type = EXCLUDED.profit_swing_type, " +
                            "  announcement_category = EXCLUDED.announcement_category, " +
                            "  announcement_date = EXCLUDED.announcement_date, source_link = EXCLUDED.source_link",
                    symbol, companyName, quarterLabel, quarterEndDate, revenueCr, netProfitCr,
                    revenueYoyCr, netProfitYoyCr, revenueYoyPct, netProfitYoyPct, profitSwingType,
                    announcementCategory, Timestamp.from(announcementDate.toInstant()), sourceLink);
            String profitYoyDisplay = profitSwingType != null ? profitSwingType : fmt(netProfitYoyPct) + "%";
            logger.info("[QuarterlyResults] {} {}: revenue={} Cr (YoY {}%), net profit={} Cr (YoY {})",
                    symbol, quarterLabel, revenueCr, fmt(revenueYoyPct), netProfitCr, profitYoyDisplay);
        } catch (Exception e) {
            logger.warn("[QuarterlyResults] upsert failed for {} {}: {}", symbol, quarterLabel, e.getMessage());
        }
    }

    private String fmt(Double v) {
        return v == null ? "n/a" : String.format("%.1f", v);
    }
}
