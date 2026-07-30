package com.adil.nsealerts;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

/**
 * Computes two comparisons for the latest quarter and upserts one row into
 * Postgres's quarterly_results table:
 *   - YoY: the SAME quarter a year ago, matched by exact quarter-end date --
 *     not a fragile "4 columns back" positional assumption, since a gap in
 *     Screener's series would silently misalign that.
 *   - QoQ: the immediately preceding quarter (added 2026-07-30, after
 *     reviewing WAAREEENER's real Jun 2026 filing -- YoY alone read as
 *     unambiguous growth while QoQ showed both metrics had actually
 *     declined from Mar 2026, a real signal YoY alone hides). Positional
 *     (index-1) is safe for QoQ, unlike YoY, since "previous column" IS the
 *     definition of quarter-over-quarter -- but still sanity-checked against
 *     the actual date gap in case Screener's series has a hole there.
 *
 * Only called for announcements FundamentalScreener actually found a
 * non-empty quarterly series for -- see AlertPoller's category filter for
 * why this isn't attempted on every announcement, unlike the existing
 * Sales-Growth-3Y screening fetch.
 */
@Component
public class QuarterlyResultsService {
    private static final Logger logger = LoggerFactory.getLogger(QuarterlyResultsService.class);

    private final JdbcTemplate jdbcTemplate;
    private final PromptRatingService promptRatingService;
    private final RsRankLookupService rsRankLookupService;

    public QuarterlyResultsService(JdbcTemplate jdbcTemplate, PromptRatingService promptRatingService,
                                    RsRankLookupService rsRankLookupService) {
        this.jdbcTemplate = jdbcTemplate;
        this.promptRatingService = promptRatingService;
        this.rsRankLookupService = rsRankLookupService;
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
        List<Double> revenueSeries = fr.getQuarterlyRevenueCrFull();
        List<Double> profitSeries = fr.getQuarterlyNetProfitCrFull();
        List<Double> marginSeries = fr.getQuarterlyOpmPctFull();
        List<Double> epsSeries = fr.getQuarterlyEpsFull();
        Double revenueCr = valueAt(revenueSeries, lastIdx);
        Double netProfitCr = valueAt(profitSeries, lastIdx);
        Double operatingMarginPct = valueAt(marginSeries, lastIdx);
        Double eps = valueAt(epsSeries, lastIdx);

        if (revenueCr == null && netProfitCr == null) {
            logger.debug("[QuarterlyResults] {}: latest quarter ({}) has neither revenue nor profit -- skipping", symbol, quarterLabel);
            return;
        }

        Integer yoyIdx = quarterEndDate != null ? findYoyIndex(dates, quarterEndDate) : null;
        Double revenueYoyCr = yoyIdx != null ? valueAt(revenueSeries, yoyIdx) : null;
        Double netProfitYoyCr = yoyIdx != null ? valueAt(profitSeries, yoyIdx) : null;
        Double revenueYoyPct = yoyPct(revenueCr, revenueYoyCr); // revenue is never negative -- no swing case needed
        String profitYoySwingType = profitSwingType(netProfitCr, netProfitYoyCr);
        Double netProfitYoyPct = profitYoySwingType == null ? yoyPct(netProfitCr, netProfitYoyCr) : null;
        Double marginYoyPp = marginPointDiff(operatingMarginPct, yoyIdx != null ? valueAt(marginSeries, yoyIdx) : null);
        Double epsYoyPct = yoyPct(eps, yoyIdx != null ? valueAt(epsSeries, yoyIdx) : null);

        Integer qoqIdx = quarterEndDate != null ? findQoqIndex(dates, lastIdx) : null;
        Double revenueQoqCr = qoqIdx != null ? valueAt(revenueSeries, qoqIdx) : null;
        Double netProfitQoqCr = qoqIdx != null ? valueAt(profitSeries, qoqIdx) : null;
        Double revenueQoqPct = yoyPct(revenueCr, revenueQoqCr); // same "abs(base)" formula, base quarter differs
        String profitQoqSwingType = profitSwingType(netProfitCr, netProfitQoqCr);
        Double netProfitQoqPct = profitQoqSwingType == null ? yoyPct(netProfitCr, netProfitQoqCr) : null;
        Double marginQoqPp = marginPointDiff(operatingMarginPct, qoqIdx != null ? valueAt(marginSeries, qoqIdx) : null);
        Double epsQoqPct = yoyPct(eps, qoqIdx != null ? valueAt(epsSeries, qoqIdx) : null);

        String verdict = verdict(netProfitCr, revenueYoyPct, netProfitYoyPct, profitYoySwingType, marginYoyPp, epsYoyPct);
        Double rsRank = rsRankLookupService.rankFor(symbol);

        // Numbers-only judgment (2026-07-30, extended same day with margin/EPS
        // once those became available -- see PromptRatingService.judgeQuarterlyTrend's
        // docstring for why this deliberately doesn't read the filed PDF). null (API key
        // missing, or the call failed) is fine -- the card just shows no judgment line.
        String aiJudgment = promptRatingService.judgeQuarterlyTrend(companyName, quarterLabel,
                revenueCr, revenueYoyPct, revenueQoqPct, netProfitCr, netProfitYoyPct, netProfitQoqPct,
                profitYoySwingType, profitQoqSwingType, operatingMarginPct, marginYoyPp, marginQoqPp,
                eps, epsYoyPct, epsQoqPct);

        upsert(symbol, companyName, quarterLabel, quarterEndDate, revenueCr, netProfitCr,
                revenueYoyCr, netProfitYoyCr, revenueYoyPct, netProfitYoyPct, profitYoySwingType,
                revenueQoqCr, netProfitQoqCr, revenueQoqPct, netProfitQoqPct, profitQoqSwingType,
                operatingMarginPct, marginYoyPp, marginQoqPp, eps, epsYoyPct, epsQoqPct, verdict, rsRank,
                aiJudgment, announcementCategory, announcementDate, sourceLink);
    }

    /** current - base, in percentage POINTS -- margin is already a percentage, so a relative-% comparison
     * (like yoyPct's) would produce a meaningless "percent of a percent". Null if either side is missing. */
    Double marginPointDiff(Double current, Double base) {
        if (current == null || base == null) return null;
        return current - base;
    }

    /**
     * Four YoY signals (revenue, net profit, operating margin, net profit
     * missing = excluded from the tally rather than counted against it, so a
     * company for whom margin/EPS data isn't parseable can still get a
     * verdict from whatever IS available) -- QoQ is deliberately NOT counted
     * here (see module docstring: a single quarter's bounce can look like a
     * recovery while the YoY trend tells the real story, confirmed against a
     * real filing -- NUCLEUS Mar 2026, QoQ margin +1pp but YoY margin -17pp).
     * >=75% of available signals positive -> RIGHT, >=50% -> MIXED, else
     * WRONG. Then a profitability gate: a net LOSS this quarter caps a RIGHT
     * down to MIXED regardless of the tally -- otherwise a shrinking-loss
     * story (all 4 signals technically "positive") reads identical to actual
     * profitability (confirmed against SWIGGY Mar 2026). Returns null only
     * when there's no profit figure for the current quarter at all (nothing
     * to gate on) or zero YoY signals were available to tally in the first
     * place. Package-private for QuarterlyResultsServiceTest.
     */
    String verdict(Double netProfitCr, Double revenueYoyPct, Double netProfitYoyPct, String profitYoySwingType,
                    Double marginYoyPp, Double epsYoyPct) {
        if (netProfitCr == null) return null;

        int total = 0;
        int positive = 0;
        if (revenueYoyPct != null) {
            total++;
            if (revenueYoyPct > 0) positive++;
        }
        if (netProfitYoyPct != null || profitYoySwingType != null) {
            total++;
            boolean profitPositive = "LOSS_TO_PROFIT".equals(profitYoySwingType)
                    || (profitYoySwingType == null && netProfitYoyPct != null && netProfitYoyPct > 0);
            if (profitPositive) positive++;
        }
        if (marginYoyPp != null) {
            total++;
            if (marginYoyPp > 0) positive++;
        }
        if (epsYoyPct != null) {
            total++;
            if (epsYoyPct > 0) positive++;
        }
        if (total == 0) return null;

        double ratio = (double) positive / total;
        String tally = ratio >= 0.75 ? "RIGHT" : (ratio >= 0.5 ? "MIXED" : "WRONG");
        if (netProfitCr < 0 && "RIGHT".equals(tally)) return "MIXED";
        return tally;
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
                        "       net_profit_yoy_pct AS \"netProfitYoyPct\", profit_yoy_swing_type AS \"profitYoySwingType\", " +
                        "       revenue_qoq_cr AS \"revenueQoqCr\", net_profit_qoq_cr AS \"netProfitQoqCr\", " +
                        "       revenue_qoq_pct AS \"revenueQoqPct\", net_profit_qoq_pct AS \"netProfitQoqPct\", " +
                        "       profit_qoq_swing_type AS \"profitQoqSwingType\", " +
                        "       operating_margin_pct AS \"operatingMarginPct\", operating_margin_yoy_pp AS \"operatingMarginYoyPp\", " +
                        "       operating_margin_qoq_pp AS \"operatingMarginQoqPp\", eps AS \"eps\", " +
                        "       eps_yoy_pct AS \"epsYoyPct\", eps_qoq_pct AS \"epsQoqPct\", " +
                        "       verdict AS \"verdict\", rs_rank AS \"rsRank\", ai_judgment AS \"aiJudgment\", " +
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

    /** currentIdx - 1, but only if the actual date gap is a normal quarter's length (<=100 days) --
     * guards against a hole in Screener's series silently being treated as "the previous quarter". */
    Integer findQoqIndex(List<LocalDate> dates, int currentIdx) {
        int prevIdx = currentIdx - 1;
        if (prevIdx < 0 || prevIdx >= dates.size()) return null;
        LocalDate current = dates.get(currentIdx);
        LocalDate prev = dates.get(prevIdx);
        if (current == null || prev == null) return null;
        long daysBetween = ChronoUnit.DAYS.between(prev, current);
        if (daysBetween <= 0 || daysBetween > 100) return null;
        return prevIdx;
    }

    private Double valueAt(List<Double> series, int idx) {
        return idx >= 0 && idx < series.size() ? series.get(idx) : null;
    }

    private Double valueAt(List<Double> series, Integer idx) {
        return idx != null ? valueAt(series, idx.intValue()) : null;
    }

    String profitSwingType(Double current, Double base) {
        if (current == null || base == null) return null;
        boolean currentLoss = current < 0;
        boolean baseLoss = base < 0;
        if (currentLoss == baseLoss) return null; // same sign (or both exactly zero) -- a normal % comparison applies
        return baseLoss ? "LOSS_TO_PROFIT" : "PROFIT_TO_LOSS";
    }

    /** Uses abs(base) as the denominator so the SIGN of the result always means "better/worse than the base period",
     * even when base itself was negative (a loss narrowing from -100 to -50 is a +50% improvement, not -50%). */
    Double yoyPct(Double current, Double base) {
        if (current == null || base == null || base == 0) return null;
        return (current - base) / Math.abs(base) * 100.0;
    }

    private void upsert(String symbol, String companyName, String quarterLabel, LocalDate quarterEndDate,
                         Double revenueCr, Double netProfitCr, Double revenueYoyCr, Double netProfitYoyCr,
                         Double revenueYoyPct, Double netProfitYoyPct, String profitYoySwingType,
                         Double revenueQoqCr, Double netProfitQoqCr, Double revenueQoqPct, Double netProfitQoqPct,
                         String profitQoqSwingType, Double operatingMarginPct, Double marginYoyPp, Double marginQoqPp,
                         Double eps, Double epsYoyPct, Double epsQoqPct, String verdict, Double rsRank,
                         String aiJudgment, String announcementCategory,
                         OffsetDateTime announcementDate, String sourceLink) {
        try {
            jdbcTemplate.update(
                    "INSERT INTO quarterly_results " +
                            "(symbol, company_name, quarter_label, quarter_end_date, revenue_cr, net_profit_cr, " +
                            " revenue_yoy_cr, net_profit_yoy_cr, revenue_yoy_pct, net_profit_yoy_pct, profit_yoy_swing_type, " +
                            " revenue_qoq_cr, net_profit_qoq_cr, revenue_qoq_pct, net_profit_qoq_pct, profit_qoq_swing_type, " +
                            " operating_margin_pct, operating_margin_yoy_pp, operating_margin_qoq_pp, " +
                            " eps, eps_yoy_pct, eps_qoq_pct, verdict, rs_rank, " +
                            " ai_judgment, announcement_category, announcement_date, source_link) " +
                            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
                            "ON CONFLICT (symbol, quarter_label) DO UPDATE SET " +
                            "  company_name = EXCLUDED.company_name, quarter_end_date = EXCLUDED.quarter_end_date, " +
                            "  revenue_cr = EXCLUDED.revenue_cr, net_profit_cr = EXCLUDED.net_profit_cr, " +
                            "  revenue_yoy_cr = EXCLUDED.revenue_yoy_cr, net_profit_yoy_cr = EXCLUDED.net_profit_yoy_cr, " +
                            "  revenue_yoy_pct = EXCLUDED.revenue_yoy_pct, net_profit_yoy_pct = EXCLUDED.net_profit_yoy_pct, " +
                            "  profit_yoy_swing_type = EXCLUDED.profit_yoy_swing_type, " +
                            "  revenue_qoq_cr = EXCLUDED.revenue_qoq_cr, net_profit_qoq_cr = EXCLUDED.net_profit_qoq_cr, " +
                            "  revenue_qoq_pct = EXCLUDED.revenue_qoq_pct, net_profit_qoq_pct = EXCLUDED.net_profit_qoq_pct, " +
                            "  profit_qoq_swing_type = EXCLUDED.profit_qoq_swing_type, " +
                            "  operating_margin_pct = EXCLUDED.operating_margin_pct, " +
                            "  operating_margin_yoy_pp = EXCLUDED.operating_margin_yoy_pp, " +
                            "  operating_margin_qoq_pp = EXCLUDED.operating_margin_qoq_pp, " +
                            "  eps = EXCLUDED.eps, eps_yoy_pct = EXCLUDED.eps_yoy_pct, eps_qoq_pct = EXCLUDED.eps_qoq_pct, " +
                            "  verdict = EXCLUDED.verdict, rs_rank = EXCLUDED.rs_rank, " +
                            "  ai_judgment = EXCLUDED.ai_judgment, " +
                            "  announcement_category = EXCLUDED.announcement_category, " +
                            "  announcement_date = EXCLUDED.announcement_date, source_link = EXCLUDED.source_link",
                    symbol, companyName, quarterLabel, quarterEndDate, revenueCr, netProfitCr,
                    revenueYoyCr, netProfitYoyCr, revenueYoyPct, netProfitYoyPct, profitYoySwingType,
                    revenueQoqCr, netProfitQoqCr, revenueQoqPct, netProfitQoqPct, profitQoqSwingType,
                    operatingMarginPct, marginYoyPp, marginQoqPp, eps, epsYoyPct, epsQoqPct, verdict, rsRank,
                    aiJudgment, announcementCategory, Timestamp.from(announcementDate.toInstant()), sourceLink);
            String profitYoyDisplay = profitYoySwingType != null ? profitYoySwingType : fmt(netProfitYoyPct) + "%";
            String profitQoqDisplay = profitQoqSwingType != null ? profitQoqSwingType : fmt(netProfitQoqPct) + "%";
            logger.info("[QuarterlyResults] {} {}: revenue={} Cr (YoY {}%, QoQ {}%), net profit={} Cr (YoY {}, QoQ {}), " +
                            "margin={}% (YoY {}pp), eps={} (YoY {}%), verdict={}, rsRank={}, judgment={}",
                    symbol, quarterLabel, revenueCr, fmt(revenueYoyPct), fmt(revenueQoqPct), netProfitCr,
                    profitYoyDisplay, profitQoqDisplay, fmt(operatingMarginPct), fmt(marginYoyPp), fmt(eps), fmt(epsYoyPct),
                    verdict != null ? verdict : "n/a", fmt(rsRank), aiJudgment != null ? aiJudgment : "n/a");
        } catch (Exception e) {
            logger.warn("[QuarterlyResults] upsert failed for {} {}: {}", symbol, quarterLabel, e.getMessage());
        }
    }

    private String fmt(Double v) {
        return v == null ? "n/a" : String.format("%.1f", v);
    }
}
