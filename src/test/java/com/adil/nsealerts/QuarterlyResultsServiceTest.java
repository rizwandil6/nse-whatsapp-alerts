package com.adil.nsealerts;

import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class QuarterlyResultsServiceTest {

    // jdbcTemplate is never touched by the pure calc methods under test -- null is fine.
    private final QuarterlyResultsService service = new QuarterlyResultsService(null);

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
}
