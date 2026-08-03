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

    // Neither collaborator is touched by the pure calc methods under test -- null is fine.
    private final QuarterlyResultsService service = new QuarterlyResultsService(null, null);

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
    void recordIfAvailableThreadsAiJudgmentThroughToTheUpsert() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        PromptRatingService promptRatingService = mock(PromptRatingService.class);
        when(promptRatingService.judgeQuarterlyTrend(any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()))
                .thenReturn("Solid YoY growth but a concerning sequential deceleration");
        QuarterlyResultsService svc = new QuarterlyResultsService(jdbc, promptRatingService);

        FundamentalResult fr = new FundamentalResult();
        fr.setQuarterLabels(new ArrayList<>(Arrays.asList("Mar 2026", "Jun 2026")));
        fr.setQuarterEndDates(new ArrayList<>(Arrays.asList(LocalDate.parse("2026-03-31"), LocalDate.parse("2026-06-30"))));
        fr.setQuarterlyRevenueCrFull(new ArrayList<>(Arrays.asList(8480.0, 7932.0)));
        fr.setQuarterlyNetProfitCrFull(new ArrayList<>(Arrays.asList(1126.0, 892.0)));
        fr.setQuarterlyEbitdaCrFull(new ArrayList<>(Arrays.asList(1500.0, 1400.0)));

        svc.recordIfAvailable("WAAREEENER", "Waaree Energies Limited", fr, "Outcome of Board Meeting",
                OffsetDateTime.parse("2026-07-29T17:34:37Z"), "https://example.com/x");

        ArgumentCaptor<Object[]> args = ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).update(any(String.class), args.capture());
        // Column order (0-indexed): symbol,company_name,quarter_label,quarter_end_date,
        // revenue_cr,net_profit_cr,revenue_yoy_cr,net_profit_yoy_cr,revenue_yoy_pct,
        // net_profit_yoy_pct,profit_yoy_swing_type,revenue_qoq_cr,net_profit_qoq_cr,
        // revenue_qoq_pct,net_profit_qoq_pct,profit_qoq_swing_type,operating_margin_pct(16),
        // operating_margin_yoy_pp(17),operating_margin_qoq_pp(18),eps(19),eps_yoy_pct(20),
        // eps_qoq_pct(21),verdict(22),ebitda_cr(23),ebitda_yoy_cr(24),ebitda_yoy_pct(25),
        // ebitda_yoy_swing_type(26),ebitda_qoq_cr(27),ebitda_qoq_pct(28),ebitda_qoq_swing_type(29),
        // dividend_amount(30),dividend_record_date(31),ai_judgment(32),... -- rs_rank is NOT
        // written here at all (DashboardDataController attaches it live at serve time
        // instead, see that class's docstring for the AWL staleness bug this replaced).
        assertEquals("Solid YoY growth but a concerning sequential deceleration", args.getValue()[32]);
        // Jun 2026 (only quarter with a QoQ base, Mar 2026) -- no YoY base available (only 2 quarters given).
        assertEquals(1400.0, args.getValue()[23]);
        assertNull(args.getValue()[24]); // no YoY base a year earlier
        assertEquals(1500.0, args.getValue()[27]); // qoq base = Mar 2026's 1500
        assertEquals((1400.0 - 1500.0) / 1500.0 * 100.0, (Double) args.getValue()[28], 1e-9);
    }

    @Test
    void recordIfAvailableHandlesNullAiJudgmentGracefully() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        PromptRatingService promptRatingService = mock(PromptRatingService.class);
        when(promptRatingService.judgeQuarterlyTrend(any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(null); // simulates ANTHROPIC_API_KEY not set / the call failing
        QuarterlyResultsService svc = new QuarterlyResultsService(jdbc, promptRatingService);

        FundamentalResult fr = new FundamentalResult();
        fr.setQuarterLabels(new ArrayList<>(List.of("Jun 2026")));
        fr.setQuarterEndDates(new ArrayList<>(List.of(LocalDate.parse("2026-06-30"))));
        fr.setQuarterlyRevenueCrFull(new ArrayList<>(List.of(7932.0)));
        fr.setQuarterlyNetProfitCrFull(new ArrayList<>(List.of(892.0)));

        svc.recordIfAvailable("WAAREEENER", "Waaree Energies Limited", fr, "Outcome of Board Meeting",
                OffsetDateTime.now(ZoneOffset.UTC), "https://example.com/x");

        ArgumentCaptor<Object[]> args = ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).update(any(String.class), args.capture());
        assertNull(args.getValue()[30]);
    }

    // --- EBITDA (added 2026-07-31) -- reuses profitSwingType/yoyPct exactly like net
    // profit (an absolute Cr figure that can also flip sign), NOT marginPointDiff. ---

    @Test
    void ebitdaSwingReusesProfitSwingTypeLogic() {
        assertEquals("LOSS_TO_PROFIT", service.profitSwingType(120.0, -40.0));
        assertEquals("PROFIT_TO_LOSS", service.profitSwingType(-30.0, 200.0));
        assertNull(service.profitSwingType(300.0, 250.0));
    }

    // --- Stale-quarter guard (added 2026-07-31) -- real GAIL incident: today's actual
    // announcement was for the Jun 2026 quarter (PDF filename dated 30-06-2026), but
    // Screener.in's table still topped out at Mar 2026 (hadn't ingested the new
    // results yet), so the scraped "latest quarter" was silently one quarter stale --
    // same 122-day gap hit 24 other symbols the same day. Must skip rather than record. ---

    @Test
    void recordIfAvailableSkipsWhenScrapedQuarterIsStaleAndThePdfFallbackAlsoFails() {
        // "https://example.com/gail" isn't a .pdf URL, so ResultsPdfParser (via a real
        // PdfExtractor, since this uses the 2-arg test constructor) bails out immediately
        // with no network call -- confirms the end-to-end skip path when BOTH Screener
        // and the PDF fallback have nothing usable.
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        PromptRatingService promptRatingService = mock(PromptRatingService.class);
        QuarterlyResultsService svc = new QuarterlyResultsService(jdbc, promptRatingService);

        FundamentalResult fr = new FundamentalResult();
        fr.setQuarterLabels(new ArrayList<>(List.of("Mar 2026")));
        fr.setQuarterEndDates(new ArrayList<>(List.of(LocalDate.parse("2026-03-31"))));
        fr.setQuarterlyRevenueCrFull(new ArrayList<>(List.of(35577.0)));
        fr.setQuarterlyNetProfitCrFull(new ArrayList<>(List.of(1481.0)));

        // Real GAIL announcement timestamp -- 122 days after Mar 2026's quarter-end,
        // because the actual results being announced were for Jun 2026.
        svc.recordIfAvailable("GAIL", "GAIL (India) Limited", fr, "Outcome of Board Meeting",
                OffsetDateTime.parse("2026-07-31T08:40:47Z"), "https://example.com/gail");

        org.mockito.Mockito.verifyNoInteractions(jdbc);
    }

    @Test
    void recordIfAvailableFallsBackToPdfWhenScrapedQuarterIsStale() {
        // Same stale-Screener scenario as above, but this time the PDF fallback
        // successfully parses the real Jun 2026 figures -- must record THOSE, not the
        // stale Mar 2026 ones, and must not touch findYoyIndex/findQoqIndex at all
        // (the PDF already gives QoQ/YoY bases directly).
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        PromptRatingService promptRatingService = mock(PromptRatingService.class);
        ResultsPdfParser pdfParser = mock(ResultsPdfParser.class);
        ResultsPdfParser.ParsedQuarterlyPdf parsed = new ResultsPdfParser.ParsedQuarterlyPdf();
        parsed.scope = "CONSOLIDATED";
        parsed.quarterEndDate = LocalDate.parse("2026-06-30");
        parsed.revenueCr = 41350.18;
        parsed.revenueQoqCr = 35705.49;
        parsed.revenueYoyCr = 35428.81;
        parsed.netProfitCr = 4670.99;
        parsed.netProfitQoqCr = 1481.46;
        parsed.netProfitYoyCr = 2382.24;
        parsed.ebitdaCr = 7097.86;
        parsed.ebitdaQoqCr = 1453.39;
        parsed.ebitdaYoyCr = 3668.74;
        parsed.operatingMarginPct = 17.17;
        parsed.operatingMarginQoqPct = 4.07;
        parsed.operatingMarginYoyPct = 10.36;
        when(pdfParser.parse("https://example.com/gail.pdf")).thenReturn(parsed);
        QuarterlyResultsService svc = new QuarterlyResultsService(jdbc, promptRatingService, pdfParser);

        FundamentalResult fr = new FundamentalResult();
        fr.setQuarterLabels(new ArrayList<>(List.of("Mar 2026"))); // Screener's stale "latest"
        fr.setQuarterEndDates(new ArrayList<>(List.of(LocalDate.parse("2026-03-31"))));
        fr.setQuarterlyRevenueCrFull(new ArrayList<>(List.of(35577.0)));
        fr.setQuarterlyNetProfitCrFull(new ArrayList<>(List.of(1481.0)));

        svc.recordIfAvailable("GAIL", "GAIL (India) Limited", fr, "Outcome of Board Meeting",
                OffsetDateTime.parse("2026-07-31T08:40:47Z"), "https://example.com/gail.pdf");

        ArgumentCaptor<Object[]> args = ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).update(any(String.class), args.capture());
        Object[] values = args.getValue();
        assertEquals("GAIL", values[0]);
        assertEquals("Jun 2026", values[2]); // derived from the PDF's quarterEndDate, not Screener's stale label
        assertEquals(LocalDate.parse("2026-06-30"), values[3]);
        assertEquals(41350.18, (Double) values[4], 1e-6); // revenue_cr -- the PDF's real Jun 2026 figure
        assertEquals(4670.99, (Double) values[5], 1e-6);  // net_profit_cr
    }

    @Test
    void recordIfAvailableProceedsWhenLagIsANormalReportingWindow() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        PromptRatingService promptRatingService = mock(PromptRatingService.class);
        QuarterlyResultsService svc = new QuarterlyResultsService(jdbc, promptRatingService);

        FundamentalResult fr = new FundamentalResult();
        fr.setQuarterLabels(new ArrayList<>(List.of("Jun 2026")));
        fr.setQuarterEndDates(new ArrayList<>(List.of(LocalDate.parse("2026-06-30"))));
        fr.setQuarterlyRevenueCrFull(new ArrayList<>(List.of(38900.0)));
        fr.setQuarterlyNetProfitCrFull(new ArrayList<>(List.of(4292.0)));

        // 31 days after quarter-end -- a normal reporting lag, must NOT be skipped.
        svc.recordIfAvailable("GAIL", "GAIL (India) Limited", fr, "Outcome of Board Meeting",
                OffsetDateTime.parse("2026-07-31T08:40:47Z"), "https://example.com/gail");

        ArgumentCaptor<Object[]> args = ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).update(any(String.class), args.capture());
        assertEquals("GAIL", args.getValue()[0]);
    }
}
