package com.adil.nsealerts;

import org.junit.jupiter.api.Test;

import java.time.LocalDate;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Fixture text below is a condensed, faithful reproduction of GAIL's real Jun 2026
 * results PDF (the incident that motivated this class -- see QuarterlyResultsService's
 * STALE_QUARTER_LAG_DAYS docstring), including PDFBox's real text-extraction artifacts
 * (stray spaces inside numbers like "34,797 .03") and the decoy "Consolidated ...
 * Financial Results" mentions in the Auditors' Report section that appear BEFORE the
 * real "Statement of Consolidated ... Financial Result" table header.
 */
class ResultsPdfParserTest {

    private static final String FIXTURE_TEXT =
            "Sub: Outcome of the Board Meeting -Un-Audited Financial Results (Standalone & \n" +
            "Consolidated) for the Quarter ended 30.06.2026 \n" +
            "\n" +
            "Independent Auditors' Limited Review Report on the Unaudited Standalone Financial Results of \n" +
            "GAIL (India) Limited\n" +
            "\n" +
            "Statement of Standalone Unaudited Financial Results for Quarter Ended 30th June 2026 \n" +
            "('!: in crore Except EPSJ \n" +
            "1 Income \n" +
            "Revenue from Operations 38,981.63 34,797 .03 34,792 .45 1,38,696.52 \n" +
            "Other Income 571.91 1,022.83 291.92 2,786.77 \n" +
            "Total Income 39, 553.54 35,819.86 35,084 .37 1,41,4 83.29 \n" +
            "2 Expenses \n" +
            "Finance Costs 309 .70 252.55 209.38 942.08 \n" +
            "Depreciation and Amortization Expense 864 .79 345.63 882.78 3,212.87 \n" +
            "Total Expenses 33, 780.31 34,242.78 32,550 .94 1,32,519.62 \n" +
            "5 Net Profit/ (Loss) after tax (3-4) 4,292 .33 1,262.18 1,886 .34 6,968.30 \n" +
            "\n" +
            "Independent Auditors' Limited Review Report on the Unaudited Consolidated Financial Results of GAIL {India) \n" +
            "\n" +
            "unaudited consolidated financial results which have not been reviewed by their auditors.\n" +
            "\n" +
            "Statement of Consolidated Unaudited Financial Result for the Quarter ended 30th June 2026 \n" +
            "Income \n" +
            "Revenue from Operations 41,350 .18 35,705.49 35,428.81 \n" +
            "Other Income 132.47 791.42 144.13 \n" +
            "Total Income 41,48 2.65 36,496.91 35,572 .94 \n" +
            "Expenses \n" +
            "Finance Costs 318.96 263.07 212.92 \n" +
            "Depreciation and Amortization Expense 986.53 473.56 992.72 \n" +
            "Total Expenses 35,5 57.81 34,988. 73 32,965.71 \n" +
            "Net Profit/ (Loss) for the period (5-6) 4,670.99 1,481.46 2,382 .24 \n";

    @Test
    void parsesConsolidatedStatementInPreferenceToStandalone() {
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(FIXTURE_TEXT);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.ParsedQuarterlyPdf result = parser.parse("https://example.com/gail.pdf");

        assertNotNull(result);
        assertEquals("CONSOLIDATED", result.scope);
        assertEquals(LocalDate.parse("2026-06-30"), result.quarterEndDate);
        assertEquals(41350.18, result.revenueCr, 1e-6);
        assertEquals(35705.49, result.revenueQoqCr, 1e-6);
        assertEquals(35428.81, result.revenueYoyCr, 1e-6);
        assertEquals(4670.99, result.netProfitCr, 1e-6);
        assertEquals(1481.46, result.netProfitQoqCr, 1e-6);
        assertEquals(2382.24, result.netProfitYoyCr, 1e-6);
    }

    @Test
    void derivesEbitdaAndMarginFromExpenseBreakdown() {
        // Consolidated, current quarter: revenue 41350.18, totalExpenses 35557.81 (the
        // "35,5 57.81" artifact), financeCosts 318.96, depreciation 986.53.
        // operatingProfit = revenue - totalExpenses + financeCosts + depreciation.
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(FIXTURE_TEXT);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.ParsedQuarterlyPdf result = parser.parse("https://example.com/gail.pdf");

        double expectedEbitda = 41350.18 - 35557.81 + 318.96 + 986.53;
        assertEquals(expectedEbitda, result.ebitdaCr, 1e-6);
        assertEquals(expectedEbitda / 41350.18 * 100.0, result.operatingMarginPct, 1e-6);
        // Matches Screener's own stored Mar 2026 OPM (4.1%) and Jun 2025 OPM (10%) for the
        // same company almost exactly -- cross-checked live against production data.
        assertEquals(4.07, result.operatingMarginQoqPct, 0.05);
        assertEquals(10.36, result.operatingMarginYoyPct, 0.05);
    }

    @Test
    void fallsBackToStandaloneWhenNoConsolidatedStatementExists() {
        String standaloneOnly = FIXTURE_TEXT.substring(0, FIXTURE_TEXT.indexOf("Independent Auditors' Limited Review Report on the Unaudited Consolidated"));
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(standaloneOnly);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.ParsedQuarterlyPdf result = parser.parse("https://example.com/gail.pdf");

        assertNotNull(result);
        assertEquals("STANDALONE", result.scope);
        assertEquals(38981.63, result.revenueCr, 1e-6);
        assertEquals(4292.33, result.netProfitCr, 1e-6);
    }

    @Test
    void doesNotMistakeAuditorsReportMentionForTheRealStatementHeader() {
        // The decoy "Independent Auditors' ... Consolidated Financial Results" line sits
        // BEFORE the real "Statement of Consolidated ... Financial Result" table header in
        // the fixture -- if findLineIndex matched the decoy, quarterEndDate/row lookups
        // would scan from the wrong start point and fail to find the real numbers.
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(FIXTURE_TEXT);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.ParsedQuarterlyPdf result = parser.parse("https://example.com/gail.pdf");

        assertNotNull(result);
        assertEquals(41350.18, result.revenueCr, 1e-6); // consolidated table's real value, not a decoy-scan failure
    }

    @Test
    void returnsNullWhenPdfTextCannotBeExtracted() {
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(null);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        assertNull(parser.parse("https://example.com/gail.pdf"));
    }

    @Test
    void returnsNullWhenNeitherStatementHeaderIsFound() {
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn("Some unrelated filing with no P&L table at all.");
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        assertNull(parser.parse("https://example.com/unrelated.pdf"));
    }

    @Test
    void returnsNullWhenRevenueOrNetProfitRowIsMissing() {
        String noNetProfit = "Statement of Standalone Unaudited Financial Results for Quarter Ended 30th June 2026 \n" +
                "Revenue from Operations 38,981.63 34,797.03 34,792.45 1,38,696.52 \n";
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(noNetProfit);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        assertNull(parser.parse("https://example.com/gail.pdf"));
    }

    /**
     * Real incident, 2026-08-01: India Pesticides Limited's actual Jun 2026 results PDF
     * (text-native, not scanned -- confirmed by downloading and inspecting it directly)
     * was silently skipped by the old patterns, for two independent reasons this fixture
     * is built to catch:
     *   1. Header word order: GAIL's fixture above has the qualifier AFTER the scope word
     *      ("Standalone Unaudited"), but this real filing has it BEFORE ("Unaudited
     *      Standalone") -- the old CONSOLIDATED_HEADER/STANDALONE_HEADER required the
     *      scope word immediately after "of", so this order false-negatived entirely.
     *   2. Net profit label: this filing's bottom line is "PROFIT AFTER TAX (3-4)" -- no
     *      "Net" prefix at all, unlike GAIL's "Net Profit/(Loss) after tax".
     * Also exercises the QUARTER_ENDED comma-before-year fix, since the header line here
     * ("...QUARTER ENDED 30 JUNE, 2026") is the actual line findQuarterEndDate scans first.
     */
    private static final String IPL_FIXTURE_TEXT =
            "STATEMENT OF UNAUDITED STANDALONE FINANCIAL RESULTS FOR THE QUARTER ENDED 30 JUNE, 2026 \n" +
            "(Rs. in Crores, except EPS) \n" +
            "Revenue from Operations 252.56 266.15 275.41 1,057.11 \n" +
            "PROFIT BEFORE TAX (1-2) 31.39 39.17 47.62 168.70 \n" +
            "PROFIT AFTER TAX (3-4) 23.07 31.76 35.38 122.29 \n";

    @Test
    void parsesRealFilingWithQualifierBeforeScopeWordAndProfitAfterTaxLabel() {
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(IPL_FIXTURE_TEXT);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.ParsedQuarterlyPdf result = parser.parse("https://example.com/india-pesticides.pdf");

        assertNotNull(result);
        assertEquals("STANDALONE", result.scope);
        assertEquals(LocalDate.parse("2026-06-30"), result.quarterEndDate);
        assertEquals(252.56, result.revenueCr, 1e-6);
        assertEquals(266.15, result.revenueQoqCr, 1e-6);
        assertEquals(275.41, result.revenueYoyCr, 1e-6);
        assertEquals(23.07, result.netProfitCr, 1e-6);
        assertEquals(31.76, result.netProfitQoqCr, 1e-6);
        assertEquals(35.38, result.netProfitYoyCr, 1e-6);
    }
}
