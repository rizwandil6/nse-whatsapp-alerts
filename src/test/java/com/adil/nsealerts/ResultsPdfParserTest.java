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

    /**
     * Real regression, 2026-08-01, caught in the same backfill session that added the
     * (un)?audited word-order fix above: that widening made the header patterns ALSO match
     * the Independent Auditors' Report decoy sentence whenever it happens to read "...the
     * accompanying statement of unaudited standalone financial results of <Company>..." --
     * confirmed on Celebrity Fashions Ltd's and Indian Terrain Fashions Ltd's real filings.
     * The un-widened pattern never matched this decoy (it lacked "standalone" immediately
     * after "of"); GAIL's fixture's decoy phrasing ("Report on the Unaudited Standalone
     * Financial Results of GAIL") never contained "statement of" at all, so this fixture is
     * needed to catch it. Fix: anchor to line start -- the decoy is always mid-sentence, the
     * real header is always its own line.
     */
    @Test
    void doesNotMatchAuditorsReportDecoyEvenWhenItContainsStandaloneAfterOf() {
        String withDecoy =
                "We have reviewed the accompanying statement of unaudited standalone financial results of \n" +
                "Example Company Limited (the 'Company') for the quarter ended June 30, 2026, (the \n" +
                "'Statement'). \n" +
                "Statement of Unaudited Financial Results for the Quarter Ended 30th June 2026 \n" +
                "a. Revenue from Operations 26.42 43.49 40.67 172.06 \n" +
                "Net Profit/(Loss) after Tax for the period (0.83) (0.90) (6.19) (4.91) \n";
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(withDecoy);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.ParsedQuarterlyPdf result = parser.parse("https://example.com/example.pdf");

        assertNotNull(result); // would be null if the decoy line were used as the header start
        assertEquals(26.42, result.revenueCr, 1e-6);
        assertEquals(-0.83, result.netProfitCr, 1e-6);
    }

    /**
     * Real incident, 2026-08-01: Celebrity Fashions Ltd's actual filing has no separate
     * consolidated statement (no subsidiaries) and its header omits the scope word
     * entirely -- "Statement of Unaudited Financial Results...", not "...Standalone
     * Financial Results...". Falls back to UNSCOPED_HEADER, treated as STANDALONE.
     */
    @Test
    void parsesUnscopedHeaderAsStandalone() {
        String unscoped =
                "Statement of Unaudited Financial Results for the Quarter Ended 30th June 2026 \n" +
                "a. Revenue from Operations 26.42 43.49 40.67 172.06 \n" +
                "Net Profit/(Loss) after Tax for the period (0.83) (0.90) (6.19) (4.91) \n";
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(unscoped);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.ParsedQuarterlyPdf result = parser.parse("https://example.com/celebrity.pdf");

        assertNotNull(result);
        assertEquals("STANDALONE", result.scope);
        assertEquals(26.42, result.revenueCr, 1e-6);
        assertEquals(-0.83, result.netProfitCr, 1e-6);
    }

    /**
     * Real incident, 2026-08-03: Ganesha Ecosphere Ltd's (GANECOS) actual Jun 2026 filing
     * writes the quarter-end date month-first, US-style -- "quarter ended June 30, 2026" --
     * instead of the day-first order every other real filing seen so far used ("quarter
     * ended 30 June 2026" / "...30th June, 2026"). QUARTER_ENDED_DMY alone never matches
     * this line (it requires digits before the month name), so the header/revenue/profit
     * were all found fine but the whole parse still failed on "no quarter-end date".
     */
    @Test
    void parsesMonthFirstUsStyleQuarterEndedDate() {
        String mdyDate =
                "Statement of Unaudited Consolidated Financial Results for the quarter ended June 30, 2026 \n" +
                "I Revenue from operations 42,366.67 42,394.13 33,712.42 1,48,166.29 \n" +
                "IX Profit for the period (VII-VIII) 2,903.48 2,321.14 1,075.36 3,821.35 \n";
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(mdyDate);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.ParsedQuarterlyPdf result = parser.parse("https://example.com/ganecos.pdf");

        assertNotNull(result);
        assertEquals(LocalDate.parse("2026-06-30"), result.quarterEndDate);
        assertEquals(42366.67, result.revenueCr, 1e-6);
        assertEquals(2903.48, result.netProfitCr, 1e-6);
    }

    /**
     * Real incident, 2026-08-03: GlaxoSmithKline Pharmaceuticals' real Jun 2026 filing
     * reports every figure as a bare whole number -- "93844", "382167" -- no decimal point
     * and no thousand-separator commas at all. The old NUMBER_PATTERN required a decimal
     * point, so it matched literally zero numbers on every row, failing with "Could not
     * find Revenue/Net Profit rows" despite the header and every row being present and
     * otherwise readable.
     */
    @Test
    void parsesPlainWholeNumbersWithNoDecimalOrThousandSeparator() {
        String wholeNumbers =
                "STATEMENT OF CONSOLIDATED UNAUDITED FINANCIAL RESULTS FOR THE QUARTER ENDED 30TH JUNE, 2026 \n" +
                "1 Revenue from operations 93844 99530 80517 382167 \n" +
                "9 Profit for the period/year (7-8) 23718 27786 20501 103598 \n";
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(wholeNumbers);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.ParsedQuarterlyPdf result = parser.parse("https://example.com/glaxo.pdf");

        assertNotNull(result);
        assertEquals(93844.0, result.revenueCr, 1e-6);
        assertEquals(99530.0, result.revenueQoqCr, 1e-6);
        assertEquals(80517.0, result.revenueYoyCr, 1e-6);
        assertEquals(23718.0, result.netProfitCr, 1e-6);
    }

    /**
     * Real regression caught while fixing the whole-number case above: once NUMBER_PATTERN
     * stopped requiring a decimal point, a bare row-reference like "(3-4)" or "(7-8)" (e.g.
     * "Net Profit/(Loss) after tax (3-4) 4,292.33 ...") started matching as if "3" or "4"
     * were themselves the first real value, silently producing e.g. -3.0 instead of the
     * real figure. findRowValues now strips these markers before number-matching.
     */
    @Test
    void rowReferenceMarkerIsNotMistakenForTheFirstValue() {
        String withRowRef =
                "Statement of Standalone Unaudited Financial Results for the Quarter Ended 30th June 2026 \n" +
                "Revenue from Operations 252.56 266.15 275.41 1,057.11 \n" +
                "Net Profit/(Loss) after tax (3-4) 23.07 31.76 35.38 122.29 \n";
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(withRowRef);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.ParsedQuarterlyPdf result = parser.parse("https://example.com/rowref.pdf");

        assertNotNull(result);
        assertEquals(23.07, result.netProfitCr, 1e-6); // not -3.0 (from the "(3-4)" marker)
        assertEquals(31.76, result.netProfitQoqCr, 1e-6);
        assertEquals(35.38, result.netProfitYoyCr, 1e-6);
    }

    /**
     * Real incident, 2026-08-03: Ganesha Ecosphere's (GANECOS) real revenue row extracts as
     * "42,366.67 42.394.13 33,712.42 1,48, 166.29" -- the SECOND value's thousands comma came
     * out as a decimal point ("42,394.13" -> "42.394.13", two decimal points in one token).
     * Left unfixed, the decimal-bearing branch of NUMBER_PATTERN greedily matches only
     * "42.39" and stops, silently producing a QoQ comparison base 1000x too small and a
     * resulting QoQ% in the hundred-thousands -- confirmed live: GANECOS's real
     * revenue_yoy_pct/qoq_pct came out as 1,025,727% / 99,845% before this fix.
     */
    @Test
    void misplacedThousandsPeriodIsNormalizedBackToAComma() {
        String withMisplacedPeriod =
                "Statement of Unaudited Consolidated Financial Results for the quarter ended June 30, 2026 \n" +
                "I Revenue from operations 42,366.67 42.394.13 33,712.42 1,48,166.29 \n" +
                "IX Profit for the period (VII-VIII) 2,903.48 2,321.14 1,075.36 3,821.35 \n";
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(withMisplacedPeriod);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.ParsedQuarterlyPdf result = parser.parse("https://example.com/ganecos-revenue.pdf");

        assertNotNull(result);
        assertEquals(42366.67, result.revenueCr, 1e-6);
        assertEquals(42394.13, result.revenueQoqCr, 1e-6); // not 42.39
        assertEquals(33712.42, result.revenueYoyCr, 1e-6);
    }

    /**
     * Real incident, 2026-08-03: several companies declare a dividend in the SAME "Outcome
     * of Board Meeting" PDF as their quarterly results (e.g. Great Eastern Shipping's real
     * Jun 2026 filing: "declared Interim Dividend of Rs. 14.40 per equity share.").
     */
    @Test
    void scansRealDividendDeclarationFromTheSamePdf() {
        // Verbatim shape from Great Eastern Shipping's real Jun 2026 filing: "Declared" has
        // a stray space from font/kerning extraction ("D eclared"), "for FY 2026-27" sits
        // between "dividend" and "of Rs.", "per share" has no "equity" before it, and the
        // Record Date sentence is month-first ("August 07, 2026") with a line break and a
        // >80-char gap after "Record Date" before the actual date appears.
        String withDividend =
                "2. D eclared an interim dividend for FY 2026-27 of Rs. 14.40 per share to the equity\n" +
                "shareholders of the Company.\n" +
                "The 'Record Date' fixed for the purpose of ascertaining the shareholders eligible \n" +
                "for receiving interim dividend is August 07, 2026. The interim dividend will be paid \n" +
                "to the shareholders on or after August 27, 2026.";
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(withDividend);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.DividendInfo info = parser.scanForDividend("https://example.com/geship.pdf");

        assertNotNull(info);
        assertEquals(14.40, info.amountPerShare, 1e-6);
        assertEquals(LocalDate.parse("2026-08-07"), info.recordDate);
    }

    /**
     * Real regression case built directly from GlaxoSmithKline's real Jun 2026 filing: "5.
     * Final dividend of Rs. 57 per equity share for the year ended 31st March 2026 had been
     * approved" -- a backward-looking note about a PRIOR year's already-approved dividend,
     * not a new declaration from THIS board meeting. Must NOT be reported as a new dividend.
     */
    @Test
    void doesNotMistakeABackwardLookingDividendNoteForANewDeclaration() {
        String priorYearNote =
                "5. Final dividend of Rs. 57 per equity share for the year ended 31st March 2026 " +
                "had been approved by the shareholders at the Annual General Meeting.";
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn(priorYearNote);
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        ResultsPdfParser.DividendInfo info = parser.scanForDividend("https://example.com/glaxo.pdf");

        assertNull(info);
    }

    @Test
    void returnsNullWhenNoDividendMentionedAtAll() {
        PdfExtractor extractor = mock(PdfExtractor.class);
        when(extractor.extractFullText(any())).thenReturn("Statement of Standalone Unaudited Financial Results...");
        ResultsPdfParser parser = new ResultsPdfParser(extractor);

        assertNull(parser.scanForDividend("https://example.com/no-dividend.pdf"));
    }
}
