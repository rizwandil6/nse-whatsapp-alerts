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
        when(promptRatingService.judgeQuarterlyTrend(any(), any(), any(), any(), any(), any(), any(), any(), any(), any()))
                .thenReturn("Solid YoY growth but a concerning sequential deceleration");
        QuarterlyResultsService svc = new QuarterlyResultsService(jdbc, promptRatingService);

        FundamentalResult fr = new FundamentalResult();
        fr.setQuarterLabels(new ArrayList<>(Arrays.asList("Mar 2026", "Jun 2026")));
        fr.setQuarterEndDates(new ArrayList<>(Arrays.asList(LocalDate.parse("2026-03-31"), LocalDate.parse("2026-06-30"))));
        fr.setQuarterlyRevenueCrFull(new ArrayList<>(Arrays.asList(8480.0, 7932.0)));
        fr.setQuarterlyNetProfitCrFull(new ArrayList<>(Arrays.asList(1126.0, 892.0)));

        svc.recordIfAvailable("WAAREEENER", "Waaree Energies Limited", fr, "Outcome of Board Meeting",
                OffsetDateTime.parse("2026-07-29T17:34:37Z"), "https://example.com/x");

        ArgumentCaptor<Object[]> args = ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).update(any(String.class), args.capture());
        // ai_judgment is the 17th positional "?" in the upsert SQL (1-indexed) -- index 16 here.
        assertEquals("Solid YoY growth but a concerning sequential deceleration", args.getValue()[16]);
    }

    @Test
    void recordIfAvailableHandlesNullAiJudgmentGracefully() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        PromptRatingService promptRatingService = mock(PromptRatingService.class);
        when(promptRatingService.judgeQuarterlyTrend(any(), any(), any(), any(), any(), any(), any(), any(), any(), any()))
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
        assertNull(args.getValue()[16]);
    }
}
