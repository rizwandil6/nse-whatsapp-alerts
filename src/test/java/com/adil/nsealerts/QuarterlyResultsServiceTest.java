package com.adil.nsealerts;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class QuarterlyResultsServiceTest {

    // None of the collaborators are touched by the pure calc methods under test -- null is fine.
    private final QuarterlyResultsService service = new QuarterlyResultsService(null, null, null);

    @Test
    void yoyPctNormalGrowth() {
        assertEquals(12.5, service.yoyPct(4500.0, 4000.0), 1e-9);
    }

    @Test
    void yoyPctNormalDecline() {
        assertEquals(-10.0, service.yoyPct(900.0, 1000.0), 1e-9);
    }

    @Test
    void yoyPctShrinkingLossIsAPositiveImprovement() {
        // Loss narrowed from -100 to -50 -- an improvement, must read as +50%, not -50%.
        assertEquals(50.0, service.yoyPct(-50.0, -100.0), 1e-9);
    }

    @Test
    void yoyPctWideningLossIsNegative() {
        // Loss widened from -50 to -100 -- a worsening, must read as -100%.
        assertEquals(-100.0, service.yoyPct(-100.0, -50.0), 1e-9);
    }

    @Test
    void yoyPctNullWhenEitherValueMissing() {
        assertNull(service.yoyPct(null, 100.0));
        assertNull(service.yoyPct(100.0, null));
    }

    @Test
    void yoyPctNullWhenPriorYearWasExactlyZero() {
        assertNull(service.yoyPct(100.0, 0.0));
    }

    @Test
    void profitSwingDetectsLossToProfit() {
        assertEquals("LOSS_TO_PROFIT", service.profitSwingType(45.0, -30.0));
    }

    @Test
    void profitSwingDetectsProfitToLoss() {
        assertEquals("PROFIT_TO_LOSS", service.profitSwingType(-45.0, 30.0));
    }

    @Test
    void profitSwingNullWhenBothProfit() {
        assertNull(service.profitSwingType(620.0, 550.0));
    }

    @Test
    void profitSwingNullWhenBothLoss() {
        assertNull(service.profitSwingType(-20.0, -80.0));
    }

    @Test
    void profitSwingNullWhenEitherMissing() {
        assertNull(service.profitSwingType(null, -30.0));
        assertNull(service.profitSwingType(45.0, null));
    }

    @Test
    void findYoyIndexMatchesExactDateOneYearBack() {
        List<LocalDate> dates = Arrays.asList(
                LocalDate.parse("2025-03-31"), LocalDate.parse("2025-06-30"),
                LocalDate.parse("2025-09-30"), LocalDate.parse("2025-12-31"),
                LocalDate.parse("2026-03-31"));
        assertEquals(0, service.findYoyIndex(dates, LocalDate.parse("2026-03-31")));
    }

    @Test
    void findYoyIndexNullWhenAYearAgoIsMissingFromTheSeries() {
        // Simulates a gap in Screener's series -- must not silently fall back to a
        // wrong positional guess (e.g. "4 back"), which is exactly the bug this
        // date-matching approach was built to avoid.
        List<LocalDate> dates = Arrays.asList(
                LocalDate.parse("2025-06-30"), LocalDate.parse("2025-09-30"),
                LocalDate.parse("2025-12-31"), LocalDate.parse("2026-03-31"));
        assertNull(service.findYoyIndex(dates, LocalDate.parse("2026-03-31")));
    }

    // --- QoQ (added 2026-07-30, after WAAREEENER's real Jun 2026 filing showed YoY
    // alone hides a real sequential decline -- see QuarterlyResultsService docstring) ---

    @Test
    void findQoqIndexIsImmediatelyPrecedingQuarter() {
        List<LocalDate> dates = Arrays.asList(
                LocalDate.parse("2025-09-30"), LocalDate.parse("2025-12-31"),
                LocalDate.parse("2026-03-31"), LocalDate.parse("2026-06-30"));
        assertEquals(2, service.findQoqIndex(dates, 3)); // Jun 2026 -> Mar 2026
    }

    @Test
    void findQoqIndexNullAtTheStartOfTheSeries() {
        List<LocalDate> dates = Arrays.asList(LocalDate.parse("2026-06-30"));
        assertNull(service.findQoqIndex(dates, 0));
    }

    @Test
    void findQoqIndexNullWhenTheGapIsTooLargeForAQuarter() {
        // Simulates a missing quarter in Screener's series -- "index-1" would silently
        // be a HALF-year-ago quarter, not the true immediately-preceding one.
        List<LocalDate> dates = Arrays.asList(
                LocalDate.parse("2025-12-31"), LocalDate.parse("2026-06-30")); // Mar 2026 missing
        assertNull(service.findQoqIndex(dates, 1));
    }

    @Test
    void realWaareeenerJun2026QoqRevealsASequentialDeclineYoyHides() {
        // Real data (2026-07-30 verification run): YoY alone reads as unambiguous growth
        // (+79% revenue, +15% profit) -- QoQ shows both metrics actually declined from
        // the immediately preceding quarter. This is the whole reason QoQ was added.
        assertEquals(-6.462264150943396, service.yoyPct(7932.0, 8480.0), 1e-9); // reuses the same base-relative formula
        assertEquals(-20.781527531083483, service.yoyPct(892.0, 1126.0), 1e-9);
        assertNull(service.profitSwingType(892.0, 1126.0)); // both profitable -- no swing
    }

    // --- Margin point-diff (added 2026-07-30) -- percentage POINTS, not a relative %,
    // since margin is already itself a percentage. ---

    @Test
    void marginPointDiffExpansion() {
        assertEquals(1.0, service.marginPointDiff(11.0, 10.0), 1e-9);
    }

    @Test
    void marginPointDiffCompression() {
        // Real NUCLEUS Mar 2026 figures -- margin nearly halved YoY (33% -> 16%).
        assertEquals(-17.0, service.marginPointDiff(16.0, 33.0), 1e-9);
    }

    @Test
    void marginPointDiffNullWhenEitherMissing() {
        assertNull(service.marginPointDiff(null, 10.0));
        assertNull(service.marginPointDiff(11.0, null));
    }

    // --- Verdict (added 2026-07-30) -- 4 YoY signals tallied (revenue, profit, margin,
    // EPS), then a profitability gate. All three real filings below are from the
    // sample shown to the user before this was built (THERMAX/SWIGGY/NUCLEUS Mar 2026). ---

    @Test
    void verdictRightWhenAllFourYoySignalsPositiveAndProfitable() {
        // THERMAX Mar 2026: revenue +12.5%, profit +18.4%, margin +1.0pp, EPS +18.7%, profit=244cr.
        assertEquals("RIGHT", service.verdict(244.0, 12.5, 18.4, null, 1.0, 18.7));
    }

    @Test
    void verdictCappedAtMixedWhenStillALossDespiteAllPositiveSignals() {
        // SWIGGY Mar 2026: all 4 signals technically positive (loss narrowing counts),
        // but net profit this quarter is still -800cr -- must not read as RIGHT.
        assertEquals("MIXED", service.verdict(-800.0, 44.7, 26.0, null, 11.0, 38.7));
    }

    @Test
    void verdictWrongWhenAllFourYoySignalsNegativeDespiteProfitability() {
        // NUCLEUS Mar 2026: revenue -1.7%, profit -46.2%, margin -17pp, EPS -46.7%, profit=35cr (still positive).
        assertEquals("WRONG", service.verdict(35.0, -1.7, -46.2, null, -17.0, -46.7));
    }

    @Test
    void verdictLossToProfitSwingCountsAsPositive() {
        // Swing type replaces the raw pct (see profitSwingType) -- a LOSS_TO_PROFIT
        // swing must count as a positive signal even though netProfitYoyPct is null.
        assertEquals("RIGHT", service.verdict(50.0, 10.0, null, "LOSS_TO_PROFIT", 2.0, 15.0));
    }

    @Test
    void verdictProfitToLossSwingCountsAsNegative() {
        assertEquals("WRONG", service.verdict(-50.0, -5.0, null, "PROFIT_TO_LOSS", -3.0, -20.0));
    }

    @Test
    void verdictNullWhenCurrentQuarterProfitMissing() {
        // Can't apply the profitability gate at all without a current-quarter figure.
        assertNull(service.verdict(null, 10.0, 10.0, null, 1.0, 10.0));
    }

    @Test
    void verdictNullWhenNoYoySignalsAvailableAtAll() {
        assertNull(service.verdict(50.0, null, null, null, null, null));
    }

    @Test
    void verdictComputesFromWhicheverSignalsAreAvailable() {
        // Only revenue + profit available (margin/EPS unparseable for this company) --
        // both positive -- 2/2 -> ratio 1.0 -> RIGHT, profitable so no cap.
        assertEquals("RIGHT", service.verdict(100.0, 10.0, 10.0, null, null, null));
    }

    // --- AI judgment (added 2026-07-30) -- PromptRatingService.judgeQuarterlyTrend's
    // numbers-only verdict, threaded through to the ai_judgment column so the
    // dashboard card shows "your judgment" alongside the figures. Deliberately NOT
    // sourced from the filed PDF (see that method's docstring: PdfExtractor's 4000-char
    // truncation meant the AI only ever saw WAAREEENER's cover letter on a real test,
    // 2026-07-30, giving an uninformative verdict) -- mocked here since the real call
    // needs a live ANTHROPIC_API_KEY; this test only verifies the threading/wiring. ---

    @Test
    void recordIfAvailableThreadsAiJudgmentAndRsRankThroughToTheUpsert() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        PromptRatingService promptRatingService = mock(PromptRatingService.class);
        RsRankLookupService rsRankLookupService = mock(RsRankLookupService.class);
        when(promptRatingService.judgeQuarterlyTrend(any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any()))
                .thenReturn("Solid YoY growth but a concerning sequential deceleration");
        when(rsRankLookupService.rankFor("WAAREEENER")).thenReturn(72.5);
        QuarterlyResultsService svc = new QuarterlyResultsService(jdbc, promptRatingService, rsRankLookupService);

        FundamentalResult fr = new FundamentalResult();
        fr.setQuarterLabels(new ArrayList<>(Arrays.asList("Mar 2026", "Jun 2026")));
        fr.setQuarterEndDates(new ArrayList<>(Arrays.asList(LocalDate.parse("2026-03-31"), LocalDate.parse("2026-06-30"))));
        fr.setQuarterlyRevenueCrFull(new ArrayList<>(Arrays.asList(8480.0, 7932.0)));
        fr.setQuarterlyNetProfitCrFull(new ArrayList<>(Arrays.asList(1126.0, 892.0)));

        svc.recordIfAvailable("WAAREEENER", "Waaree Energies Limited", fr, "Outcome of Board Meeting",
                OffsetDateTime.parse("2026-07-29T17:34:37Z"), "https://example.com/x");

        ArgumentCaptor<Object[]> args = ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).update(any(String.class), args.capture());
        // Column order (0-indexed): symbol,company_name,quarter_label,quarter_end_date,
        // revenue_cr,net_profit_cr,revenue_yoy_cr,net_profit_yoy_cr,revenue_yoy_pct,
        // net_profit_yoy_pct,profit_yoy_swing_type,revenue_qoq_cr,net_profit_qoq_cr,
        // revenue_qoq_pct,net_profit_qoq_pct,profit_qoq_swing_type,operating_margin_pct(16),
        // operating_margin_yoy_pp(17),operating_margin_qoq_pp(18),eps(19),eps_yoy_pct(20),
        // eps_qoq_pct(21),verdict(22),rs_rank(23),ai_judgment(24),...
        assertEquals(72.5, args.getValue()[23]);
        assertEquals("Solid YoY growth but a concerning sequential deceleration", args.getValue()[24]);
    }

    @Test
    void recordIfAvailableHandlesNullAiJudgmentGracefully() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        PromptRatingService promptRatingService = mock(PromptRatingService.class);
        RsRankLookupService rsRankLookupService = mock(RsRankLookupService.class);
        when(promptRatingService.judgeQuarterlyTrend(any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any()))
                .thenReturn(null); // simulates ANTHROPIC_API_KEY not set / the call failing
        when(rsRankLookupService.rankFor(any())).thenReturn(null); // symbol not in the RS Momentum universe
        QuarterlyResultsService svc = new QuarterlyResultsService(jdbc, promptRatingService, rsRankLookupService);

        FundamentalResult fr = new FundamentalResult();
        fr.setQuarterLabels(new ArrayList<>(List.of("Jun 2026")));
        fr.setQuarterEndDates(new ArrayList<>(List.of(LocalDate.parse("2026-06-30"))));
        fr.setQuarterlyRevenueCrFull(new ArrayList<>(List.of(7932.0)));
        fr.setQuarterlyNetProfitCrFull(new ArrayList<>(List.of(892.0)));

        svc.recordIfAvailable("WAAREEENER", "Waaree Energies Limited", fr, "Outcome of Board Meeting",
                OffsetDateTime.now(ZoneOffset.UTC), "https://example.com/x");

        ArgumentCaptor<Object[]> args = ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).update(any(String.class), args.capture());
        assertNull(args.getValue()[23]);
        assertNull(args.getValue()[24]);
    }
}
