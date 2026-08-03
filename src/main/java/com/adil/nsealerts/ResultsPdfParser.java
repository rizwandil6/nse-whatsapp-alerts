package com.adil.nsealerts;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Fallback for when Screener.in's quarterly table hasn't caught up yet with an
 * announcement being processed RIGHT NOW (see QuarterlyResultsService's
 * STALE_QUARTER_LAG_DAYS guard) -- parses the actual filed "Outcome of Board
 * Meeting" results PDF directly instead of skipping the announcement outright.
 *
 * Real incident this was built for (2026-07-31): GAIL's announcement PDF
 * (filename dated 30-06-2026) was for the Jun 2026 quarter, but Screener.in's
 * table still topped out at Mar 2026 -- 25 symbols hit the same lag the same
 * day. The filing itself always has the true current-quarter numbers the
 * moment it's filed, plus the immediately-preceding-quarter (QoQ) and
 * same-quarter-last-year (YoY) columns in the SAME table -- no external lag
 * possible, unlike Screener.
 *
 * Revenue and Net Profit are literal, SEBI-mandated line items and are
 * extracted directly. Operating margin/EBITDA are NOT literal line items in
 * these filings -- they're derived here as Revenue - (Total Expenses -
 * Finance Costs - Depreciation), mirroring Screener's own "Operating Profit"
 * convention (see FundamentalScreener's parseQuarterlyResults docstring), but
 * this derivation hasn't been cross-verified against Screener's own exact
 * normalization (e.g. some companies net out excise duty differently) --
 * treat these two specifically as approximate. Every other field this class
 * doesn't confidently parse is left null rather than guessed.
 *
 * PDFBox's text extraction reliably keeps each P&L row on one line, but
 * inserts stray spaces INSIDE numbers in several different positions --
 * confirmed on GAIL's real filing: "34,797 .03" (before the decimal point),
 * "34,988. 73" (after it), "33, 780.31" (right after a comma), and even
 * "1,41,4 83.29" (splitting a 3-digit group in the middle) -- all due to
 * font-kerning artifacts, not consistent in position. normalizeNumberSpacing
 * collapses all four before NUMBER_PATTERN ever runs, rather than trying to
 * make one regex tolerate every position at once (an earlier version that
 * only handled the comma/pre-decimal cases silently mis-parsed the
 * mid-group-split case, corrupting the Total Expenses figure and, with it,
 * the derived EBITDA -- caught by a fixture test built directly from this
 * real filing's exact text before this was ever trusted).
 */
@Service
public class ResultsPdfParser {
    private static final Logger logger = LoggerFactory.getLogger(ResultsPdfParser.class);

    // Three alternatives, tried in order at each position:
    //   1. Comma-grouped (Indian style, >=1 group required so a plain run can't partially
    //      match as just its first 3 digits), optional decimal.
    //   2. Any-length integer WITH a mandatory decimal point -- a decimal point is an
    //      unambiguous signal of a real figure regardless of digit count (e.g. "23.07"),
    //      so no minimum-digit floor here.
    //   3. A BARE integer, no comma, no decimal -- requires >=3 digits. Widened 2026-08-03
    //      to accept whole-Lakh figures with no paise and no thousand-separators at all
    //      (confirmed live: GlaxoSmithKline's real Jun 2026 filing -- "93844", "382167").
    //      The >=3-digit floor on THIS alternative specifically is deliberate: without it,
    //      a bare "3" or "4" from a row-reference marker like "(3-4)" starts matching as if
    //      it were the first real value -- confirmed on GAIL/IPL's fixtures AND, in the
    //      wild the same day, corrupted variants of the same marker ("(5+/-6)" on Hubtown,
    //      "{7-8)" on Kalpataru, curly-brace/plus-slash artifacts from font decoding) that a
    //      literal "(N-N)" strip regex couldn't have caught either. No real revenue/profit/
    //      EBITDA-component figure in Lakhs/Crores reporting is genuinely 1-2 digits, so this
    //      floor costs nothing on real data while closing off the whole class of markers.
    private static final Pattern NUMBER_PATTERN =
            Pattern.compile("\\(?-?(?:\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d{1,2})?|\\d+\\.\\d{1,2}|\\d{3,}(?:\\.\\d{1,2})?)\\)?");

    // Applied to a line's remainder (after the label) before NUMBER_PATTERN runs --
    // see class docstring for the four distinct artifact positions these fix, in order.
    private static final Pattern SPACE_AFTER_COMMA = Pattern.compile(",\\s+");
    private static final Pattern SPACE_MID_GROUP = Pattern.compile("(,\\d)\\s+(\\d{2}\\.)");
    private static final Pattern SPACE_BEFORE_DECIMAL = Pattern.compile("(\\d)\\s+(\\.)");
    private static final Pattern SPACE_AFTER_DECIMAL = Pattern.compile("(\\.)\\s+(\\d)");
    // A 5th artifact position, confirmed 2026-08-03 on Ganesha Ecosphere's real filing:
    // the thousands COMMA itself gets extracted as a decimal POINT instead of dropped or
    // spaced -- "42,394.13" comes out as "42.394.13" (two decimal points). A real number
    // never legitimately contains two decimal points, so this is unambiguous: whenever a
    // token has exactly this "\d{1,3}.\d{3}.\d{1,2}" shape, the first "." is standing in
    // for a comma. Left unfixed, NUMBER_PATTERN's decimal-bearing alternative greedily
    // matches only the first "42.39" and stops, silently producing a QoQ/YoY comparison
    // base 1000x too small -- confirmed live: GANECOS's revenue_yoy_pct came out as
    // 1,025,727% before this fix.
    private static final Pattern MISPLACED_THOUSANDS_PERIOD = Pattern.compile("(\\d{1,3})\\.(\\d{3})\\.(\\d{1,2})(?!\\d)");

    // Must require the "Statement of ..." prefix -- a bare "consolidated ... financial
    // result[s]" also matches the Independent Auditors' Report section (and several
    // notes) which appear BEFORE the actual P&L table in every filing seen so far
    // (confirmed on GAIL's real filing: the auditors' report false-matched at line 98/445,
    // ~80-270 lines before the real table headers at line 178/622).
    //
    // The optional (un)?audited group right after "of" handles a real filing-to-filing
    // word-order difference, confirmed 2026-08-01: GAIL's header puts the qualifier AFTER
    // the scope word ("Statement of Standalone Unaudited Financial Results" -- already
    // covered by the .{0,60} gap before "financial result"), but India Pesticides' real
    // Jun 2026 filing puts it BEFORE ("Statement of Unaudited Standalone Financial
    // Results") -- the old pattern required "standalone"/"consolidated" immediately after
    // "of", so this word order silently false-negatived and skipped a perfectly parseable,
    // text-native PDF (not a scanned-PDF case -- see ResultsPdfParserTest for the fixture
    // built from this real filing).
    //
    // ^\s* anchor added 2026-08-01 (same backfill session, caught immediately after the
    // (un)?audited widening above went live): the widened pattern started matching the
    // Independent Auditors' Report decoy sentence too, whenever THAT sentence happens to
    // phrase it as "...the accompanying statement of unaudited standalone financial
    // results of <Company>..." (real filings: Celebrity Fashions, Indian Terrain Fashions)
    // -- a decoy the un-widened pattern never matched because it lacked "standalone"
    // immediately after "of". The real table header is always its own line starting with
    // "Statement of ..."; the decoy is always mid-sentence. Anchoring to line-start
    // restores the original decoy immunity without giving up the word-order fix.
    private static final Pattern CONSOLIDATED_HEADER =
            Pattern.compile("^\\s*statement\\s+of\\s+(?:(?:un)?audited\\s+)?consolidated.{0,60}financial result", Pattern.CASE_INSENSITIVE);
    private static final Pattern STANDALONE_HEADER =
            Pattern.compile("^\\s*statement\\s+of\\s+(?:(?:un)?audited\\s+)?standalone.{0,60}financial result", Pattern.CASE_INSENSITIVE);
    // Some filers (confirmed 2026-08-01: Celebrity Fashions, Utkarsh Small Finance Bank)
    // don't file a separate consolidated statement at all -- no subsidiaries to
    // consolidate -- and their table header omits the scope word entirely: "Statement of
    // Unaudited Financial Results for the Quarter Ended ...", not "...Standalone Financial
    // Results...". Only consulted when neither CONSOLIDATED_HEADER nor STANDALONE_HEADER
    // matches (see parse()) -- treated as STANDALONE since that's the closest real meaning
    // (one statement, not a group consolidation).
    private static final Pattern UNSCOPED_HEADER =
            Pattern.compile("^\\s*statement\\s+of\\s+(?:(?:un)?audited\\s+)?financial result", Pattern.CASE_INSENSITIVE);
    // Optional comma before the year (2026-08-01): findQuarterEndDate only scans the
    // header line itself plus the next 4 lines, and India Pesticides' header line reads
    // "...FOR THE QUARTER ENDED 30 JUNE, 2026" -- the comma sits where the old pattern
    // required plain whitespace, so the header line itself (the most likely place to find
    // this) failed to match.
    private static final Pattern QUARTER_ENDED_DMY =
            Pattern.compile("quarter\\s+ended\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+([A-Za-z]+)\\s*,?\\s+(\\d{4})",
                    Pattern.CASE_INSENSITIVE);
    // US-style month-first order, confirmed 2026-08-03 (Ganesha Ecosphere's real Jun 2026
    // filing): "Statement of Unaudited Consolidated Financial Results for the quarter ended
    // June 30, 2026" -- month name before the day, not day-before-month like every other
    // filing seen so far. Tried as a fallback (see findQuarterEndDate) so the far more
    // common DMY order keeps matching first.
    private static final Pattern QUARTER_ENDED_MDY =
            Pattern.compile("quarter\\s+ended\\s+([A-Za-z]+)\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})",
                    Pattern.CASE_INSENSITIVE);

    private static final Pattern REVENUE_LABEL = Pattern.compile("revenue\\s+from\\s+operations", Pattern.CASE_INSENSITIVE);
    private static final Pattern TOTAL_EXPENSES_LABEL = Pattern.compile("total\\s+expenses", Pattern.CASE_INSENSITIVE);
    private static final Pattern FINANCE_COSTS_LABEL = Pattern.compile("finance\\s+costs?", Pattern.CASE_INSENSITIVE);
    private static final Pattern DEPRECIATION_LABEL =
            Pattern.compile("depreciation\\s+and\\s+amorti[sz]ation\\s+expense", Pattern.CASE_INSENSITIVE);
    // "net" made optional 2026-08-01: India Pesticides' real filing labels the bottom line
    // "Profit After Tax" with no "Net" at all -- equally standard SEBI terminology to
    // "Net Profit", just not the only form GAIL's fixture happened to use.
    private static final Pattern NET_PROFIT_LABEL =
            Pattern.compile("(?:net\\s+)?profit\\s*(?:/\\s*\\(?\\s*loss\\s*\\)?)?\\s*(?:after\\s+tax|for\\s+the\\s+period)",
                    Pattern.CASE_INSENSITIVE);

    // Only the fields this parser knows how to fill -- QuarterlyResultsService
    // treats every other column as unavailable (null) for a PDF-fallback row.
    public static class ParsedQuarterlyPdf {
        public String scope; // "CONSOLIDATED" or "STANDALONE" -- which statement was actually used
        public LocalDate quarterEndDate;
        public Double revenueCr, revenueYoyCr, revenueQoqCr;
        public Double netProfitCr, netProfitYoyCr, netProfitQoqCr;
        public Double ebitdaCr, ebitdaYoyCr, ebitdaQoqCr; // derived, approximate -- see class docstring
        public Double operatingMarginPct, operatingMarginYoyPct, operatingMarginQoqPct; // derived, approximate
    }

    private final PdfExtractor pdfExtractor;

    public ResultsPdfParser(PdfExtractor pdfExtractor) {
        this.pdfExtractor = pdfExtractor;
    }

    /** Returns null if the PDF can't be downloaded/parsed, or if the minimum required
     * fields (quarter end date, revenue, net profit) can't be confidently located --
     * this never fabricates a partial/guessed row. */
    public ParsedQuarterlyPdf parse(String pdfUrl) {
        String fullText = pdfExtractor.extractFullText(pdfUrl);
        if (fullText == null || fullText.isBlank()) return null;

        String[] lines = fullText.split("\n");

        int consolidatedIdx = findLineIndex(lines, CONSOLIDATED_HEADER);
        int standaloneIdx = findLineIndex(lines, STANDALONE_HEADER);

        String scope;
        int startIdx;
        if (consolidatedIdx >= 0) {
            scope = "CONSOLIDATED";
            startIdx = consolidatedIdx;
        } else if (standaloneIdx >= 0) {
            scope = "STANDALONE";
            startIdx = standaloneIdx;
        } else {
            int unscopedIdx = findLineIndex(lines, UNSCOPED_HEADER);
            if (unscopedIdx < 0) {
                logger.warn("[ResultsPdfParser] No Standalone/Consolidated statement header found in {}", pdfUrl);
                return null;
            }
            scope = "STANDALONE";
            startIdx = unscopedIdx;
        }
        // Bound the scan to before the OTHER statement (if it appears later), or ~120
        // lines -- comfortably more than one P&L statement's row count, without
        // risking bleeding into the other scope's table.
        int otherIdx = "CONSOLIDATED".equals(scope) ? standaloneIdx : consolidatedIdx;
        int endIdx = (otherIdx > startIdx) ? otherIdx : Math.min(lines.length, startIdx + 120);

        LocalDate quarterEndDate = findQuarterEndDate(lines, startIdx, Math.min(lines.length, startIdx + 5));
        if (quarterEndDate == null) {
            logger.warn("[ResultsPdfParser] Could not find a 'Quarter ended <date>' heading near the {} statement in {}", scope, pdfUrl);
            return null;
        }

        double[] revenue = findRowValues(lines, startIdx, endIdx, REVENUE_LABEL);
        double[] netProfit = findRowValues(lines, startIdx, endIdx, NET_PROFIT_LABEL);
        if (revenue == null || netProfit == null) {
            logger.warn("[ResultsPdfParser] Could not find Revenue/Net Profit rows in the {} statement in {}", scope, pdfUrl);
            return null;
        }

        ParsedQuarterlyPdf result = new ParsedQuarterlyPdf();
        result.scope = scope;
        result.quarterEndDate = quarterEndDate;
        result.revenueCr = revenue[0];
        result.revenueQoqCr = revenue[1];
        result.revenueYoyCr = revenue[2];
        result.netProfitCr = netProfit[0];
        result.netProfitQoqCr = netProfit[1];
        result.netProfitYoyCr = netProfit[2];

        double[] totalExpenses = findRowValues(lines, startIdx, endIdx, TOTAL_EXPENSES_LABEL);
        double[] financeCosts = findRowValues(lines, startIdx, endIdx, FINANCE_COSTS_LABEL);
        double[] depreciation = findRowValues(lines, startIdx, endIdx, DEPRECIATION_LABEL);
        if (totalExpenses != null && financeCosts != null && depreciation != null) {
            result.ebitdaCr = operatingProfit(revenue[0], totalExpenses[0], financeCosts[0], depreciation[0]);
            result.ebitdaQoqCr = operatingProfit(revenue[1], totalExpenses[1], financeCosts[1], depreciation[1]);
            result.ebitdaYoyCr = operatingProfit(revenue[2], totalExpenses[2], financeCosts[2], depreciation[2]);
            result.operatingMarginPct = revenue[0] != 0 ? result.ebitdaCr / revenue[0] * 100.0 : null;
            result.operatingMarginQoqPct = revenue[1] != 0 ? result.ebitdaQoqCr / revenue[1] * 100.0 : null;
            result.operatingMarginYoyPct = revenue[2] != 0 ? result.ebitdaYoyCr / revenue[2] * 100.0 : null;
        } else {
            logger.info("[ResultsPdfParser] Total Expenses/Finance Costs/Depreciation rows not all found in the {} " +
                    "statement in {} -- EBITDA/margin left null (revenue/net profit still usable).", scope, pdfUrl);
        }

        logger.info("[ResultsPdfParser] Parsed {} statement from {}: quarterEndDate={}, revenue={} (QoQ base {}, YoY base {}), " +
                        "netProfit={} (QoQ base {}, YoY base {}), ebitda={}",
                scope, pdfUrl, quarterEndDate, result.revenueCr, result.revenueQoqCr, result.revenueYoyCr,
                result.netProfitCr, result.netProfitQoqCr, result.netProfitYoyCr, result.ebitdaCr);
        return result;
    }

    private double operatingProfit(double revenue, double totalExpenses, double financeCosts, double depreciation) {
        return revenue - totalExpenses + financeCosts + depreciation;
    }

    private int findLineIndex(String[] lines, Pattern pattern) {
        for (int i = 0; i < lines.length; i++) {
            if (pattern.matcher(lines[i]).find()) return i;
        }
        return -1;
    }

    private LocalDate findQuarterEndDate(String[] lines, int fromIdx, int toIdx) {
        for (int i = fromIdx; i < toIdx; i++) {
            Matcher dmy = QUARTER_ENDED_DMY.matcher(lines[i]);
            if (dmy.find()) {
                LocalDate parsed = parseDmyDate(dmy.group(1), dmy.group(2), dmy.group(3), lines[i]);
                if (parsed != null) return parsed;
            }
            Matcher mdy = QUARTER_ENDED_MDY.matcher(lines[i]);
            if (mdy.find()) {
                LocalDate parsed = parseDmyDate(mdy.group(2), mdy.group(1), mdy.group(3), lines[i]);
                if (parsed != null) return parsed;
            }
        }
        return null;
    }

    /** Shared by both DMY and MDY matches, once each has been normalized to (day, monthName, year). */
    private LocalDate parseDmyDate(String dayStr, String monthName, String yearStr, String sourceLine) {
        try {
            int day = Integer.parseInt(dayStr);
            int year = Integer.parseInt(yearStr);
            int month = java.time.Month.valueOf(monthName.toUpperCase(Locale.ROOT)).getValue();
            return LocalDate.of(year, month, day);
        } catch (Exception e) {
            // fall through to try formatting via DateTimeFormatter as a second attempt
            try {
                return LocalDate.parse(dayStr + " " + monthName + " " + yearStr,
                        DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.ENGLISH));
            } catch (Exception e2) {
                logger.warn("[ResultsPdfParser] Failed to parse quarter-end date from '{}': {}", sourceLine, e2.getMessage());
                return null;
            }
        }
    }

    /** [current, QoQ base, YoY base] -- the first 3 numbers on whichever line matches
     * `labelPattern` within [fromIdx, toIdx). Null if the label isn't found in that
     * range, or fewer than 3 numbers follow it on that line. */
    private double[] findRowValues(String[] lines, int fromIdx, int toIdx, Pattern labelPattern) {
        for (int i = fromIdx; i < toIdx; i++) {
            Matcher labelMatch = labelPattern.matcher(lines[i]);
            if (!labelMatch.find()) continue;
            String remainder = normalizeNumberSpacing(lines[i].substring(labelMatch.end()));
            Matcher numMatch = NUMBER_PATTERN.matcher(remainder);
            double[] values = new double[3];
            int found = 0;
            while (numMatch.find() && found < 3) {
                values[found++] = parseNumber(numMatch.group());
            }
            if (found == 3) return values;
        }
        return null;
    }

    private String normalizeNumberSpacing(String remainder) {
        String s = MISPLACED_THOUSANDS_PERIOD.matcher(remainder).replaceAll("$1,$2.$3");
        s = SPACE_AFTER_COMMA.matcher(s).replaceAll(",");
        s = SPACE_MID_GROUP.matcher(s).replaceAll("$1$2");
        s = SPACE_BEFORE_DECIMAL.matcher(s).replaceAll("$1$2");
        s = SPACE_AFTER_DECIMAL.matcher(s).replaceAll("$1$2");
        return s;
    }

    private double parseNumber(String raw) {
        boolean negative = raw.startsWith("(") || raw.startsWith("-");
        String cleaned = raw.replace("(", "").replace(")", "").replace(",", "").replace(" ", "").replace("-", "");
        double value = Double.parseDouble(cleaned);
        return negative ? -value : value;
    }
}
