package com.adil.nsealerts;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class AnalysisResultTest {

    @Test
    void gettersReturnValuesAndQuickVerdictDefaults() {
        AnalysisResult result = new AnalysisResult(7.5, 120.0, "", "Summary text", "High Priority");

        assertEquals(7.5, result.getRating());
        assertEquals(120.0, result.getOrderSizeCrores());
        assertEquals("No quick verdict", result.getQuickVerdict());
        assertEquals("Summary text", result.getSummary());
        assertEquals("High Priority", result.getImpactLevel());
    }
}
