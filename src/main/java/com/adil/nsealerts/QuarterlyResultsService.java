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

    /** Normal NSE reporting lag (quarter-end to results announcement) tops out around 45 days.
     * A gap past this means Screener.in's "latest" column is a QUARTER BEHIND the actual
     * announcement being processed (Screener hasn't ingested the new results yet) -- confirmed
     * live 2026-07-31: GAIL's real announcement was for the Jun 2026 quarter (PDF filename
     * dated 30-06-2026), but Screener's table still topped out at Mar 2026, so the scraped
     * "latest quarter" was silently one quarter stale -- and the SAME 122-day gap hit 24 other
     * symbols the same day (a bulk results-season lag, not a one-off). See recordIfAvailable's
     * staleness guard below. */
    private static final long STALE_QUARTER_LAG_DAYS = 60;

    private static final java.time.format.DateTimeFormatter QUARTER_LABEL_FORMAT =
            java.time.format.DateTimeFormatter.ofPattern("MMM yyyy", java.util.Locale.ENGLISH);

    private final JdbcTemplate jdbcTemplate;
    private final PromptRatingService promptRatingService;
    private final ResultsPdfParser resultsPdfParser;

    /** Test/convenience constructor -- PDF fallback still works (builds its own
     * PdfExtractor), just without Spring managing that instance. */
    public QuarterlyResultsService(JdbcTemplate jdbcTemplate, PromptRatingService promptRatingService) {
        this(jdbcTemplate, promptRatingService, new ResultsPdfParser(new PdfExtractor()));
    }

    @org.springframework.beans.factory.annotation.Autowired
    public QuarterlyResultsService(JdbcTemplate jdbcTemplate, PromptRatingService promptRatingService,
                                    ResultsPdfParser resultsPdfParser) {
        this.jdbcTemplate = jdbcTemplate;
        this.promptRatingService = promptRatingService;
        this.resultsPdfParser = resultsPdfParser;
    }

    public void recordIfAvailable(String symbol, String companyName, FundamentalResult fr,
                                   String announcementCategory, OffsetDateTime announcementDate, String sourceLink) {
        if (fr == null) return;
        List<String> labels = fr.getQuarterLabels();
        List<LocalDate> dates = fr.getQuarterEndDates();
        if (labels.isEmpty() || dates.isEmpty()) {
            logger.debug("[QuarterlyResults] {}: no quarter labels/dates parsed -- skipping", symbol);
            recordFailure(symbol, companyName, null, "no_quarter_data",
                    "Screener.in returned no quarter labels/dates", sourceLink, announcementDate);
            return;
        }

        int lastIdx = labels.size() - 1;
        String quarterLabel = labels.get(lastIdx);
        LocalDate quarterEndDate = dates.get(lastIdx);

        if (quarterEndDate != null) {
            long lagDays = ChronoUnit.DAYS.between(quarterEndDate, announcementDate.toLocalDate());
            if (lagDays > STALE_QUARTER_LAG_DAYS) {
                logger.warn("[QuarterlyResults] {}: latest Screener quarter ({}, ended {}) is {} days before " +
                                "this announcement ({}) -- Screener likely hasn't ingested the new quarter yet; " +
                                "falling back to parsing the filed results PDF directly.",
                        symbol, quarterLabel, quarterEndDate, lagDays, announcementDate.toLocalDate());
                recordFromPdfFallback(symbol, companyName, announcementCategory, announcementDate, sourceLink);
                return;
            }
        }

        List<Double> revenueSeries = fr.getQuarterlyRevenueCrFull();
        List<Double> profitSeries = fr.getQuarterlyNetProfitCrFull();
        List<Double> marginSeries = fr.getQuarterlyOpmPctFull();
        List<Double> epsSeries = fr.getQuarterlyEpsFull();
        List<Double> ebitdaSeries = fr.getQuarterlyEbitdaCrFull();
        Double revenueCr = valueAt(revenueSeries, lastIdx);
        Double netProfitCr = valueAt(profitSeries, lastIdx);
        Double operatingMarginPct = valueAt(marginSeries, lastIdx);
        Double eps = valueAt(epsSeries, lastIdx);
        Double ebitdaCr = valueAt(ebitdaSeries, lastIdx);

        if (revenueCr == null && netProfitCr == null) {
            logger.debug("[QuarterlyResults] {}: latest quarter ({}) has neither revenue nor profit -- skipping", symbol, quarterLabel);
            recordFailure(symbol, companyName, quarterLabel, "no_revenue_or_profit",
                    "Screener.in series had neither revenue nor net profit for " + quarterLabel, sourceLink, announcementDate);
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
        Double ebitdaYoyCr = yoyIdx != null ? valueAt(ebitdaSeries, yoyIdx) : null;
        String ebitdaYoySwingType = profitSwingType(ebitdaCr, ebitdaYoyCr);
        Double ebitdaYoyPct = ebitdaYoySwingType == null ? yoyPct(ebitdaCr, ebitdaYoyCr) : null;

        Integer qoqIdx = quarterEndDate != null ? findQoqIndex(dates, lastIdx) : null;
        Double revenueQoqCr = qoqIdx != null ? valueAt(revenueSeries, qoqIdx) : null;
        Double netProfitQoqCr = qoqIdx != null ? valueAt(profitSeries, qoqIdx) : null;
        Double revenueQoqPct = yoyPct(revenueCr, revenueQoqCr); // same "abs(base)" formula, base quarter differs
        String profitQoqSwingType = profitSwingType(netProfitCr, netProfitQoqCr);
        Double netProfitQoqPct = profitQoqSwingType == null ? yoyPct(netProfitCr, netProfitQoqCr) : null;
        Double marginQoqPp = marginPointDiff(operatingMarginPct, qoqIdx != null ? valueAt(marginSeries, qoqIdx) : null);
        Double epsQoqPct = yoyPct(eps, qoqIdx != null ? valueAt(epsSeries, qoqIdx) : null);
        Double ebitdaQoqCr = qoqIdx != null ? valueAt(ebitdaSeries, qoqIdx) : null;
        String ebitdaQoqSwingType = profitSwingType(ebitdaCr, ebitdaQoqCr);
        Double ebitdaQoqPct = ebitdaQoqSwingType == null ? yoyPct(ebitdaCr, ebitdaQoqCr) : null;

        String verdict = verdict(netProfitCr, revenueYoyPct, netProfitYoyPct, profitYoySwingType, marginYoyPp, epsYoyPct);

        // Numbers-only judgment (2026-07-30, extended same day with margin/EPS
        // once those became available -- see PromptRatingService.judgeQuarterlyTrend's
        // docstring for why this deliberately doesn't read the filed PDF). null (API key
        // missing, or the call failed) is fine -- the card just shows no judgment line.
        String aiJudgment = promptRatingService.judgeQuarterlyTrend(companyName, quarterLabel,
                revenueCr, revenueYoyPct, revenueQoqPct, netProfitCr, netProfitYoyPct, netProfitQoqPct,
                profitYoySwingType, profitQoqSwingType, operatingMarginPct, marginYoyPp, marginQoqPp,
                eps, epsYoyPct, epsQoqPct, ebitdaCr, ebitdaYoyPct, ebitdaQoqPct,
                ebitdaYoySwingType, ebitdaQoqSwingType);

        ResultsPdfParser.DividendInfo dividendInfo = scanForDividendSafely(sourceLink);

        upsert(symbol, companyName, quarterLabel, quarterEndDate, revenueCr, netProfitCr,
                revenueYoyCr, netProfitYoyCr, revenueYoyPct, netProfitYoyPct, profitYoySwingType,
                revenueQoqCr, netProfitQoqCr, revenueQoqPct, netProfitQoqPct, profitQoqSwingType,
                operatingMarginPct, marginYoyPp, marginQoqPp, eps, epsYoyPct, epsQoqPct, verdict,
                ebitdaCr, ebitdaYoyCr, ebitdaYoyPct, ebitdaYoySwingType,
                ebitdaQoqCr, ebitdaQoqPct, ebitdaQoqSwingType,
                dividendInfo != null ? dividendInfo.amountPerShare : null,
                dividendInfo != null ? dividendInfo.recordDate : null,
                aiJudgment, announcementCategory, announcementDate, sourceLink);
    }

    /** Screener.in doesn't carry dividend data at all, so this is called for EVERY recorded
     * quarter regardless of whether the financial figures themselves came from Screener or
     * the PDF fallback -- always needs the filed PDF itself. Best-effort: any failure here
     * (bad URL, unreachable NSE, unparseable PDF) must never block recording the actual
     * results, so it's caught and logged rather than propagated. */
    private ResultsPdfParser.DividendInfo scanForDividendSafely(String sourceLink) {
        try {
            return resultsPdfParser.scanForDividend(sourceLink);
        } catch (Exception e) {
            logger.warn("[QuarterlyResults] Dividend scan failed for {}: {}", sourceLink, e.getMessage());
            return null;
        }
    }

    /** Fallback path when Screener.in's own table is stale relative to `announcementDate`
     * (see the STALE_QUARTER_LAG_DAYS guard in recordIfAvailable) -- parses the actual
     * filed results PDF instead. The PDF already gives current/QoQ-base/YoY-base in one
     * table, so this skips findYoyIndex/findQoqIndex entirely (no series/index lookup
     * needed). EPS is left null (not parsed -- see ResultsPdfParser's docstring); margin/
     * EBITDA are derived approximations, flagged as such in the log line. No-ops (logs
     * and returns) if the PDF can't be parsed -- never records a guessed row. */
    private void recordFromPdfFallback(String symbol, String companyName, String announcementCategory,
                                        OffsetDateTime announcementDate, String sourceLink) {
        ResultsPdfParser.ParsedQuarterlyPdf pdf = resultsPdfParser.parse(sourceLink);
        if (pdf == null) {
            logger.warn("[QuarterlyResults] {}: PDF fallback could not extract a usable result from {} -- skipping.",
                    symbol, sourceLink);
            recordFailure(symbol, companyName, null, "pdf_unparseable",
                    "ResultsPdfParser could not extract a usable result from the filed PDF", sourceLink, announcementDate);
            return;
        }

        String quarterLabel = QUARTER_LABEL_FORMAT.format(pdf.quarterEndDate);
        String profitYoySwingType = profitSwingType(pdf.netProfitCr, pdf.netProfitYoyCr);
        Double netProfitYoyPct = profitYoySwingType == null ? yoyPct(pdf.netProfitCr, pdf.netProfitYoyCr) : null;
        String profitQoqSwingType = profitSwingType(pdf.netProfitCr, pdf.netProfitQoqCr);
        Double netProfitQoqPct = profitQoqSwingType == null ? yoyPct(pdf.netProfitCr, pdf.netProfitQoqCr) : null;
        Double revenueYoyPct = yoyPct(pdf.revenueCr, pdf.revenueYoyCr);
        Double revenueQoqPct = yoyPct(pdf.revenueCr, pdf.revenueQoqCr);
        Double marginYoyPp = marginPointDiff(pdf.operatingMarginPct, pdf.operatingMarginYoyPct);
        Double marginQoqPp = marginPointDiff(pdf.operatingMarginPct, pdf.operatingMarginQoqPct);
        String ebitdaYoySwingType = profitSwingType(pdf.ebitdaCr, pdf.ebitdaYoyCr);
        Double ebitdaYoyPct = ebitdaYoySwingType == null ? yoyPct(pdf.ebitdaCr, pdf.ebitdaYoyCr) : null;
        String ebitdaQoqSwingType = profitSwingType(pdf.ebitdaCr, pdf.ebitdaQoqCr);
        Double ebitdaQoqPct = ebitdaQoqSwingType == null ? yoyPct(pdf.ebitdaCr, pdf.ebitdaQoqCr) : null;

        String verdict = verdict(pdf.netProfitCr, revenueYoyPct, netProfitYoyPct, profitYoySwingType, marginYoyPp, null);

        String aiJudgment = promptRatingService.judgeQuarterlyTrend(companyName, quarterLabel,
                pdf.revenueCr, revenueYoyPct, revenueQoqPct, pdf.netProfitCr, netProfitYoyPct, netProfitQoqPct,
                profitYoySwingType, profitQoqSwingType, pdf.operatingMarginPct, marginYoyPp, marginQoqPp,
                null, null, null, pdf.ebitdaCr, ebitdaYoyPct, ebitdaQoqPct, ebitdaYoySwingType, ebitdaQoqSwingType);

        ResultsPdfParser.DividendInfo dividendInfo = scanForDividendSafely(sourceLink);

        upsert(symbol, companyName, quarterLabel, pdf.quarterEndDate, pdf.revenueCr, pdf.netProfitCr,
                pdf.revenueYoyCr, pdf.netProfitYoyCr, revenueYoyPct, netProfitYoyPct, profitYoySwingType,
                pdf.revenueQoqCr, pdf.netProfitQoqCr, revenueQoqPct, netProfitQoqPct, profitQoqSwingType,
                pdf.operatingMarginPct, marginYoyPp, marginQoqPp, null, null, null, verdict,
                pdf.ebitdaCr, pdf.ebitdaYoyCr, ebitdaYoyPct, ebitdaYoySwingType,
                pdf.ebitdaQoqCr, ebitdaQoqPct, ebitdaQoqSwingType,
                dividendInfo != null ? dividendInfo.amountPerShare : null,
                dividendInfo != null ? dividendInfo.recordDate : null,
                aiJudgment, announcementCategory, announcementDate, sourceLink);
        logger.info("[QuarterlyResults] {} {}: recorded from PDF fallback ({} statement, {}) -- revenue/net profit exact, " +
                        "margin/EBITDA are derived approximations (see ResultsPdfParser docstring).",
                symbol, quarterLabel, pdf.scope, sourceLink);
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
                        "       ebitda_cr AS \"ebitdaCr\", ebitda_yoy_cr AS \"ebitdaYoyCr\", " +
                        "       ebitda_yoy_pct AS \"ebitdaYoyPct\", ebitda_yoy_swing_type AS \"ebitdaYoySwingType\", " +
                        "       ebitda_qoq_cr AS \"ebitdaQoqCr\", ebitda_qoq_pct AS \"ebitdaQoqPct\", " +
                        "       ebitda_qoq_swing_type AS \"ebitdaQoqSwingType\", " +
                        // rs_rank is deliberately NOT selected here -- DashboardDataController
                        // attaches it LIVE on every request instead (see that class for why:
                        // RS Rank is a day-to-day-changing stock attribute, not a fixed fact
                        // about this quarter, so trusting whatever was stored at announcement-
                        // processing time created a real race/staleness bug, confirmed on AWL
                        // 2026-07-30).
                        "       verdict AS \"verdict\", ai_judgment AS \"aiJudgment\", " +
                        "       dividend_amount AS \"dividendAmount\", dividend_record_date AS \"dividendRecordDate\", " +
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
                         Double eps, Double epsYoyPct, Double epsQoqPct, String verdict,
                         Double ebitdaCr, Double ebitdaYoyCr, Double ebitdaYoyPct, String ebitdaYoySwingType,
                         Double ebitdaQoqCr, Double ebitdaQoqPct, String ebitdaQoqSwingType,
                         Double dividendAmount, LocalDate dividendRecordDate,
                         String aiJudgment, String announcementCategory,
                         OffsetDateTime announcementDate, String sourceLink) {
        try {
            jdbcTemplate.update(
                    "INSERT INTO quarterly_results " +
                            "(symbol, company_name, quarter_label, quarter_end_date, revenue_cr, net_profit_cr, " +
                            " revenue_yoy_cr, net_profit_yoy_cr, revenue_yoy_pct, net_profit_yoy_pct, profit_yoy_swing_type, " +
                            " revenue_qoq_cr, net_profit_qoq_cr, revenue_qoq_pct, net_profit_qoq_pct, profit_qoq_swing_type, " +
                            " operating_margin_pct, operating_margin_yoy_pp, operating_margin_qoq_pp, " +
                            " eps, eps_yoy_pct, eps_qoq_pct, verdict, " +
                            " ebitda_cr, ebitda_yoy_cr, ebitda_yoy_pct, ebitda_yoy_swing_type, " +
                            " ebitda_qoq_cr, ebitda_qoq_pct, ebitda_qoq_swing_type, " +
                            " dividend_amount, dividend_record_date, " +
                            " ai_judgment, announcement_category, announcement_date, source_link) " +
                            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " +
                            "        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
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
                            "  verdict = EXCLUDED.verdict, " +
                            "  ebitda_cr = EXCLUDED.ebitda_cr, ebitda_yoy_cr = EXCLUDED.ebitda_yoy_cr, " +
                            "  ebitda_yoy_pct = EXCLUDED.ebitda_yoy_pct, ebitda_yoy_swing_type = EXCLUDED.ebitda_yoy_swing_type, " +
                            "  ebitda_qoq_cr = EXCLUDED.ebitda_qoq_cr, ebitda_qoq_pct = EXCLUDED.ebitda_qoq_pct, " +
                            "  ebitda_qoq_swing_type = EXCLUDED.ebitda_qoq_swing_type, " +
                            "  dividend_amount = EXCLUDED.dividend_amount, " +
                            "  dividend_record_date = EXCLUDED.dividend_record_date, " +
                            "  ai_judgment = EXCLUDED.ai_judgment, " +
                            "  announcement_category = EXCLUDED.announcement_category, " +
                            "  announcement_date = EXCLUDED.announcement_date, source_link = EXCLUDED.source_link",
                    symbol, companyName, quarterLabel, quarterEndDate, revenueCr, netProfitCr,
                    revenueYoyCr, netProfitYoyCr, revenueYoyPct, netProfitYoyPct, profitYoySwingType,
                    revenueQoqCr, netProfitQoqCr, revenueQoqPct, netProfitQoqPct, profitQoqSwingType,
                    operatingMarginPct, marginYoyPp, marginQoqPp, eps, epsYoyPct, epsQoqPct, verdict,
                    ebitdaCr, ebitdaYoyCr, ebitdaYoyPct, ebitdaYoySwingType,
                    ebitdaQoqCr, ebitdaQoqPct, ebitdaQoqSwingType,
                    dividendAmount, dividendRecordDate,
                    aiJudgment, announcementCategory, Timestamp.from(announcementDate.toInstant()), sourceLink);
            clearFailures(symbol);
            String profitYoyDisplay = profitYoySwingType != null ? profitYoySwingType : fmt(netProfitYoyPct) + "%";
            String profitQoqDisplay = profitQoqSwingType != null ? profitQoqSwingType : fmt(netProfitQoqPct) + "%";
            String ebitdaYoyDisplay = ebitdaYoySwingType != null ? ebitdaYoySwingType : fmt(ebitdaYoyPct) + "%";
            logger.info("[QuarterlyResults] {} {}: revenue={} Cr (YoY {}%, QoQ {}%), net profit={} Cr (YoY {}, QoQ {}), " +
                            "margin={}% (YoY {}pp), eps={} (YoY {}%), ebitda={} Cr (YoY {}), dividend={}, verdict={}, judgment={}",
                    symbol, quarterLabel, revenueCr, fmt(revenueYoyPct), fmt(revenueQoqPct), netProfitCr,
                    profitYoyDisplay, profitQoqDisplay, fmt(operatingMarginPct), fmt(marginYoyPp), fmt(eps), fmt(epsYoyPct),
                    fmt(ebitdaCr), ebitdaYoyDisplay,
                    dividendAmount != null ? ("Rs. " + dividendAmount + (dividendRecordDate != null ? " (record " + dividendRecordDate + ")" : "")) : "n/a",
                    verdict != null ? verdict : "n/a", aiJudgment != null ? aiJudgment : "n/a");
        } catch (Exception e) {
            logger.warn("[QuarterlyResults] upsert failed for {} {}: {}", symbol, quarterLabel, e.getMessage());
            recordFailure(symbol, companyName, quarterLabel, "db_error", e.getMessage(), sourceLink, announcementDate);
        }
    }

    private String fmt(Double v) {
        return v == null ? "n/a" : String.format("%.1f", v);
    }

    /** Upserts one row into quarterly_results_failures so a PDF/data-parse failure leaves a
     * visible trace instead of silently vanishing (previously indistinguishable from "NSE
     * hasn't announced this company's results yet"). Best-effort: a failure while LOGGING a
     * failure must never blow up the caller. */
    private void recordFailure(String symbol, String companyName, String quarterLabel, String reason,
                                String detail, String sourceLink, OffsetDateTime announcementDate) {
        try {
            jdbcTemplate.update(
                    "INSERT INTO quarterly_results_failures " +
                            "(symbol, company_name, quarter_label, reason, detail, source_link, announcement_date) " +
                            "VALUES (?, ?, ?, ?, ?, ?, ?) " +
                            "ON CONFLICT (symbol, COALESCE(quarter_label, '')) DO UPDATE SET " +
                            "  company_name = EXCLUDED.company_name, reason = EXCLUDED.reason, " +
                            "  detail = EXCLUDED.detail, source_link = EXCLUDED.source_link, " +
                            "  announcement_date = EXCLUDED.announcement_date, failed_at = now()",
                    symbol, companyName, quarterLabel, reason, detail, sourceLink,
                    announcementDate != null ? Timestamp.from(announcementDate.toInstant()) : null);
        } catch (Exception e) {
            logger.warn("[QuarterlyResults] failed to record parse failure for {}: {}", symbol, e.getMessage());
        }
    }

    /** Clears any previously logged failures for this symbol once a result is successfully
     * recorded -- a later successful retry means those earlier failure rows are stale, not a
     * live problem to keep surfacing on the dashboard. */
    private void clearFailures(String symbol) {
        try {
            jdbcTemplate.update("DELETE FROM quarterly_results_failures WHERE symbol = ?", symbol);
        } catch (Exception e) {
            logger.warn("[QuarterlyResults] failed to clear parse failures for {}: {}", symbol, e.getMessage());
        }
    }

    /** Backs a dashboard panel listing companies whose results couldn't be parsed --
     * most-recently-failed first. */
    public List<Map<String, Object>> recentFailures(int limit) {
        return jdbcTemplate.queryForList(
                "SELECT symbol, company_name AS \"companyName\", quarter_label AS \"quarterLabel\", " +
                        "       reason AS \"reason\", detail AS \"detail\", source_link AS \"sourceLink\", " +
                        "       to_char(announcement_date AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"announcementDate\", " +
                        "       to_char(failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"failedAt\" " +
                        "FROM quarterly_results_failures ORDER BY failed_at DESC LIMIT ?",
                limit);
    }
}
