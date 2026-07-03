package com.adil.nsealerts;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.CookieManager;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Logs into Screener.in, fetches the company page for a given NSE symbol,
 * and runs a 13-point fundamental criteria check.
 *
 * Criteria:
 *  1.  Market Cap > ₹1,000 Cr
 *  2.  PEG < 1            (computed: Stock P/E ÷ Profit Growth 5Y)
 *  3.  PE < Industry PE
 *  4.  ROE > 20%
 *  5.  ROCE > 15%
 *  6.  Debt/Equity < 0.5
 *  7.  Promoter Holding > 50%
 *  8.  Sales Growth 3Y > 15%
 *  9.  Profit Growth 5Y > 15%
 * 10.  Pledged Shares < 1%
 * 11.  OPM > 15%
 * 12.  Price/Sales < 10
 * 13.  EV/EBITDA < 25
 *
 * Data sources (in priority order):
 *  - Screener quick_ratios API  → Industry PE, Pledged, EV/EBITDA, Price/Sales, Debt/Equity
 *  - Screener main page text    → Market Cap, Stock P/E, ROE, ROCE, OPM, growth rates, Promoter
 *  - Screener main page text    → P/S (marketCap / annual Sales) and EV/EBITDA fallback
 *  - Screener sector page       → Industry PE fallback (market-cap-weighted peer average)
 *  - NSE shareholding API       → Pledged % fallback
 */
@Component
public class ScreenerCheckService {

    private static final Logger logger = LoggerFactory.getLogger(ScreenerCheckService.class);

    @Value("${screener.username:}")
    private String username;

    @Value("${screener.password:}")
    private String password;

    private final NseClient nseClient;
    private final CookieManager cookieManager = new CookieManager();
    private final HttpClient httpClient;
    private volatile boolean loggedIn = false;

    /** Per-run cache for sector PE (keyed by sector URL path). Cleared on restart. */
    private final Map<String, Double> sectorPeCache = new ConcurrentHashMap<>();

    public ScreenerCheckService(NseClient nseClient) {
        this.nseClient = nseClient;
        this.httpClient = HttpClient.newBuilder()
                .cookieHandler(cookieManager)
                .connectTimeout(Duration.ofSeconds(15))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
    }

    /**
     * Returns a formatted 13-criteria check for the given NSE symbol,
     * or an empty string if screener is unavailable / credentials missing.
     */
    public String check(String symbol) {
        if (symbol == null || symbol.isBlank()) return "";
        if (username == null || username.isBlank() || password == null || password.isBlank()) {
            logger.debug("[ScreenerCheck] Credentials not configured — skipping");
            return "";
        }
        try {
            ensureLoggedIn();
            if (!loggedIn) return "";

            // Main page — has Market Cap, Stock P/E, ROCE, ROE, OPM, growth rates,
            //              P&L table (Sales, Operating Profit, Depreciation),
            //              Balance Sheet (Borrowings, Equity Capital, Reserves),
            //              and the sector page URL embedded in the peer section.
            String mainHtml = fetchPage(symbol, "");
            if (mainHtml == null || mainHtml.isBlank()) return "";
            logger.info("[ScreenerCheck] main page fetched ({} chars) for {}", mainHtml.length(), symbol);
            String mainText = htmlToText(mainHtml);

            // The actual quick_ratios endpoint uses a NUMERIC company ID, not the symbol.
            // The ID is embedded in the main page HTML (e.g. in the Follow button URL).
            String companyId = extractCompanyId(mainHtml, symbol);
            String qrHtml = null;
            if (companyId != null) {
                String referer = "https://www.screener.in/company/" + enc(symbol) + "/";
                qrHtml = fetchAbsoluteUrl(
                        "https://www.screener.in/api/company/" + companyId + "/quick_ratios/",
                        referer);
                int qrLen = qrHtml != null ? qrHtml.length() : 0;
                logger.info("[ScreenerCheck] [{}] companyId={} qrHtml={} chars", symbol, companyId, qrLen);
                if (qrHtml != null && qrLen < 50) {
                    logger.warn("[ScreenerCheck] [{}] qrHtml short content: [{}]", symbol, qrHtml);
                }
            } else {
                logger.warn("[ScreenerCheck] [{}] could not extract numeric company ID", symbol);
            }

            return buildResult(mainHtml, mainText, qrHtml, symbol);
        } catch (Exception e) {
            logger.warn("[ScreenerCheck] Failed for {}: {}", symbol, e.getMessage());
            return "";
        }
    }

    // ── Login ─────────────────────────────────────────────────────────────────

    private synchronized void ensureLoggedIn() throws Exception {
        if (loggedIn) return;

        String loginUrl = "https://www.screener.in/login/";
        HttpResponse<String> getResp = httpClient.send(
                HttpRequest.newBuilder().uri(URI.create(loginUrl))
                        .header("User-Agent", "Mozilla/5.0")
                        .timeout(Duration.ofSeconds(15)).GET().build(),
                HttpResponse.BodyHandlers.ofString());

        String csrf = extractCsrf(getResp.body());
        if (csrf == null || csrf.isBlank()) {
            logger.warn("[ScreenerCheck] CSRF token not found on login page");
            return;
        }

        String body = "csrfmiddlewaretoken=" + enc(csrf)
                + "&username=" + enc(username)
                + "&password=" + enc(password);

        HttpResponse<String> postResp = httpClient.send(
                HttpRequest.newBuilder().uri(URI.create(loginUrl))
                        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
                        .header("Content-Type", "application/x-www-form-urlencoded")
                        .header("Referer", loginUrl)
                        .header("Origin", "https://www.screener.in")
                        .timeout(Duration.ofSeconds(15))
                        .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString());

        // A successful login redirects away from /login/; failure stays on /login/.
        String finalUri = postResp.uri().toString();
        loggedIn = !finalUri.contains("/login");

        String snippet = postResp.body().length() > 300
                ? postResp.body().substring(0, 300) : postResp.body();
        snippet = snippet.replaceAll("(?i)password[^<]{0,60}", "password=***");
        logger.info("[ScreenerCheck] Login POST → finalUri={} loggedIn={}", finalUri, loggedIn);
        if (!loggedIn) logger.warn("[ScreenerCheck] Login failed. Body snippet: [{}]", snippet);
    }

    private String extractCsrf(String html) {
        Matcher m = Pattern.compile("csrfmiddlewaretoken[^>]+value=[\"']([^\"']+)[\"']").matcher(html);
        if (m.find()) return m.group(1);
        m = Pattern.compile("value=[\"']([^\"']+)[\"'][^>]+csrfmiddlewaretoken").matcher(html);
        if (m.find()) return m.group(1);
        return null;
    }

    private String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    // ── Company ID extraction ─────────────────────────────────────────────────

    /**
     * Extracts Screener's internal numeric company ID from the main page HTML.
     * Looks for the quick_ratios URL first (most specific), then falls back to
     * the Follow button URL (/api/company/{ID}/add/) which is always the company's own ID.
     */
    private String extractCompanyId(String html, String symbol) {
        Matcher m = Pattern.compile("/api/company/(\\d+)/quick_ratios/").matcher(html);
        if (m.find()) {
            logger.info("[ScreenerCheck] [{}] companyId via quick_ratios URL: {}", symbol, m.group(1));
            return m.group(1);
        }
        m = Pattern.compile("/api/company/(\\d+)/").matcher(html);
        if (m.find()) {
            String id  = m.group(1);
            int    idx = m.start();
            String ctx = html.substring(idx, Math.min(idx + 80, html.length()));
            logger.warn("[ScreenerCheck] [{}] companyId fallback {}; ctx=[{}]", symbol, id, ctx);
            return id;
        }
        m = Pattern.compile("data-company[_-]id=[\"'](\\d+)[\"']").matcher(html);
        if (m.find()) return m.group(1);
        return null;
    }

    // ── Fetch helpers ─────────────────────────────────────────────────────────

    /** Fetches https://www.screener.in/company/{SYMBOL}/{subPath} */
    private String fetchPage(String symbol, String subPath) throws Exception {
        String companyUrl = "https://www.screener.in/company/" + enc(symbol) + "/";
        String url = companyUrl + subPath;
        HttpRequest.Builder req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("User-Agent", "Mozilla/5.0")
                .header("Referer", companyUrl)
                .timeout(Duration.ofSeconds(20));
        if (!subPath.isEmpty()) {
            req.header("X-Requested-With", "XMLHttpRequest").header("Accept", "*/*");
        }
        HttpResponse<String> resp = httpClient.send(req.GET().build(),
                HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            logger.info("[ScreenerCheck] HTTP {} for {}{}", resp.statusCode(), symbol, subPath);
            return null;
        }
        return resp.body();
    }

    /** Fetches an absolute URL with Referer + XHR headers; returns null on non-200. */
    private String fetchAbsoluteUrl(String url, String referer) throws Exception {
        HttpResponse<String> resp = httpClient.send(
                HttpRequest.newBuilder().uri(URI.create(url))
                        .header("User-Agent", "Mozilla/5.0")
                        .header("Referer", referer)
                        .header("X-Requested-With", "XMLHttpRequest")
                        .header("Accept", "text/html,*/*")
                        .timeout(Duration.ofSeconds(20))
                        .GET().build(),
                HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            logger.info("[ScreenerCheck] HTTP {} for {}", resp.statusCode(), url);
            return null;
        }
        return resp.body();
    }

    // ── HTML → plain text ─────────────────────────────────────────────────────

    private String htmlToText(String html) {
        return html
                .replaceAll("(?si)<script[^>]*>.*?</script>", " ")
                .replaceAll("(?si)<style[^>]*>.*?</style>", " ")
                .replaceAll("<[^>]+>", " ")
                .replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">")
                .replace("&#x27;", "'").replace("&quot;", "\"")
                .replaceAll("\\s+", " ").trim();
    }

    // ── Quick-ratios HTML parser ──────────────────────────────────────────────

    /**
     * Parses a named ratio from the quick_ratios HTML response.
     * Entry format: <span class="name">Ratio Name</span> ... <span class="number">VALUE</span>
     */
    private double parseQR(String html, String ratioName) {
        String escaped = Pattern.quote(ratioName);
        Matcher m = Pattern.compile(
                "class=\"name\"[^>]*>\\s*" + escaped + "\\s*</span>"
                + ".*?class=\"number\"[^>]*>([\\d,\\.]+)</span>",
                Pattern.DOTALL).matcher(html);
        if (m.find()) {
            try { return Double.parseDouble(m.group(1).replace(",", "")); }
            catch (NumberFormatException ignored) {}
        }
        return Double.NaN;
    }

    // ── External data: pledged from NSE ───────────────────────────────────────

    /**
     * Fetches the most-recent promoter pledged percentage from NSE's shareholding API.
     * On first run the NSE JSON structure is logged so field names can be verified.
     */
    private double fetchPledgedFromNse(String symbol) {
        try {
            String json = nseClient.fetchShareholdingJson(symbol);
            if (json == null || json.isBlank()) return Double.NaN;

            // Most recent entry is first. NSE field name (varies by endpoint):
            Matcher m = Pattern.compile(
                    "percentageOfSharesPledgedOrOtherwiseEncumbered[\"']?\\s*:\\s*([\\d.]+)"
            ).matcher(json);
            if (m.find()) {
                double v = Double.parseDouble(m.group(1));
                logger.info("[ScreenerCheck] [{}] Pledged from NSE={}", symbol, v);
                return v;
            }
            // Alternate field name used in some endpoints
            m = Pattern.compile("\"pledged\"\\s*:\\s*([\\d.]+)").matcher(json);
            if (m.find()) {
                double v = Double.parseDouble(m.group(1));
                logger.info("[ScreenerCheck] [{}] Pledged(alt) from NSE={}", symbol, v);
                return v;
            }
            // "missing index" (13c) = NSE has no data for this symbol yet (newly listed / SME).
            // Log as info — this is expected, not a bug.
            String snippet = json.substring(0, Math.min(300, json.length()));
            if (json.length() < 30 || snippet.toLowerCase().contains("missing")) {
                logger.info("[ScreenerCheck] [{}] NSE pledged: no data ({})", symbol, snippet.trim());
            } else {
                logger.warn("[ScreenerCheck] [{}] NSE shareholding JSON: pledged field not found. Snippet ({}c): [{}]",
                        symbol, json.length(), snippet);
            }
        } catch (Exception e) {
            logger.warn("[ScreenerCheck] [{}] NSE pledged fetch error: {}", symbol, e.getMessage());
        }
        return Double.NaN;
    }

    // ── External data: Industry PE from Screener sector page ─────────────────

    /**
     * Computes a market-cap-weighted sector PE by:
     *  1. Extracting the industry sector URL from the main page's peer section
     *     (Screener embeds: <a href="/market/..." title="Industry">)
     *  2. Fetching that public sector page (no auth required)
     *  3. Parsing each company row's P/E and Market Cap
     *  4. Returning the weighted average
     *
     * Result is cached per sector URL for the lifetime of the process.
     */
    private double fetchSectorIndustryPE(String mainHtml, String symbol) {
        try {
            // Extract the deepest industry-level URL from the peer comparison breadcrumb
            Matcher m = Pattern.compile(
                    "href=[\"'](/market/[^\"']+/)[\"'][^>]*title=[\"']Industry[\"']"
            ).matcher(mainHtml);
            if (!m.find()) {
                m = Pattern.compile(
                        "title=[\"']Industry[\"'][^>]*href=[\"'](/market/[^\"']+/)[\"']"
                ).matcher(mainHtml);
                if (!m.find()) {
                    logger.info("[ScreenerCheck] [{}] No sector URL found in HTML", symbol);
                    return Double.NaN;
                }
            }
            String sectorPath = m.group(1);

            // Return cached value if already fetched this run
            Double cached = sectorPeCache.get(sectorPath);
            if (cached != null) {
                logger.info("[ScreenerCheck] [{}] Sector PE (cached)={} path={}", symbol, f(cached), sectorPath);
                return cached;
            }

            String sectorUrl = "https://www.screener.in" + sectorPath;
            logger.info("[ScreenerCheck] [{}] Fetching sector PE from {}", symbol, sectorUrl);
            String sectorHtml = fetchAbsoluteUrl(sectorUrl,
                    "https://www.screener.in/company/" + enc(symbol) + "/");
            if (sectorHtml == null || sectorHtml.isBlank()) return Double.NaN;

            // Each data row: <td>N.</td> <td><a>Name</a>...</td> <td>CMP</td> <td>P/E</td> <td>MCap</td>
            Pattern rowPat = Pattern.compile(
                    "<td[^>]*>\\d+\\.</td>\\s*"           // S.No.
                    + "<td[^>]*>.*?</td>\\s*"             // Name (may contain nested tags)
                    + "<td[^>]*>[\\d,.]+</td>\\s*"        // CMP (not captured)
                    + "<td[^>]*>([\\d,.]+)</td>\\s*"      // P/E  ← capture
                    + "<td[^>]*>([\\d,.]+)</td>",         // Market Cap ← capture
                    Pattern.DOTALL);
            Matcher rowMatcher = rowPat.matcher(sectorHtml);

            double totalMcap  = 0;
            double weightedPE = 0;
            int    count      = 0;

            while (rowMatcher.find()) {
                try {
                    double pe   = Double.parseDouble(rowMatcher.group(1).replace(",", ""));
                    double mcap = Double.parseDouble(rowMatcher.group(2).replace(",", ""));
                    if (pe > 0 && pe < 2000 && mcap > 0) {
                        totalMcap  += mcap;
                        weightedPE += pe * mcap;
                        count++;
                    }
                } catch (NumberFormatException ignored) {}
            }

            if (count == 0 || totalMcap == 0) {
                logger.warn("[ScreenerCheck] [{}] No valid PE rows parsed from sector page", symbol);
                return Double.NaN;
            }

            double industryPE = weightedPE / totalMcap;
            logger.info("[ScreenerCheck] [{}] Sector PE={} ({} companies, path={})",
                    symbol, f(industryPE), count, sectorPath);
            sectorPeCache.put(sectorPath, industryPE);
            return industryPE;

        } catch (Exception e) {
            logger.warn("[ScreenerCheck] [{}] Sector PE fetch failed: {}", symbol, e.getMessage());
            return Double.NaN;
        }
    }

    // ── 13-criteria evaluation ────────────────────────────────────────────────

    private String buildResult(String mainHtml, String mainText, String qrHtml, String symbol) {

        // ── From main page (always server-rendered) ───────────────────────────
        double marketCap      = after(mainText, "Market Cap");
        double stockPE        = after(mainText, "Stock P/E");
        double roce           = after(mainText, "ROCE");
        double roe            = after(mainText, "ROE");
        double salesGrowth3Y  = growth(mainText, "Sales Growth",  "3 Years");
        double profitGrowth5Y = growth(mainText, "Profit Growth", "5 Years");
        double opm            = ratioLatest(mainText, "OPM %");

        // ── From quick_ratios API (works for companies with Screener data) ────
        double debtEquity = Double.NaN;
        double industryPE = Double.NaN;
        double pledged    = Double.NaN;
        double evEbitda   = Double.NaN;
        double priceSales = Double.NaN;

        if (qrHtml != null && !qrHtml.isBlank()) {
            debtEquity = parseQR(qrHtml, "Debt to equity");
            industryPE = parseQR(qrHtml, "Industry PE");
            // Promoter holding intentionally NOT taken from QR — QR uses a different
            // calculation basis than the shareholding table (verified mismatches).
            pledged    = parseQR(qrHtml, "Pledged percentage");
            evEbitda   = parseQR(qrHtml, "EVEBITDA");
            priceSales = parseQR(qrHtml, "Price to Sales");
            logger.info("[ScreenerCheck] [{}] QR → debtEq={} indPE={} pledged={} ev={} ps={}",
                    symbol, debtEquity, industryPE, pledged, evEbitda, priceSales);
        }

        // ── Fallbacks from server-rendered mainText ───────────────────────────

        // Promoter: "Promoters + 73.91% ..." is always in the shareholding section.
        double promoter = after(mainText, "Promoters");

        // Debt/Equity: compute from annual balance sheet if API didn't provide it.
        if (nan(debtEquity)) {
            double borrowings    = ratioLatest(mainText, "Borrowings");
            double equityCapital = ratioLatest(mainText, "Equity Capital");
            if (nan(equityCapital)) equityCapital = ratioLatest(mainText, "Share Capital");
            double reserves      = ratioLatest(mainText, "Reserves");
            if (!nan(borrowings) && !nan(equityCapital) && !nan(reserves)) {
                double netWorth = equityCapital + reserves;
                if (netWorth > 0) debtEquity = borrowings / netWorth;
            }
        }

        // Price/Sales: marketCap / annual revenue.
        // IMPORTANT: use section-scoped parsing so we hit the annual P&L table,
        // not the quarterly results table (which appears earlier in the HTML).
        // Screener uses different row labels by sector:
        //   Manufacturing/Products → "Sales"
        //   Services/IT            → "Revenue"
        //   Infrastructure/Power   → "Revenue from operations"  (or "Sales" too)
        if (nan(priceSales) && !nan(marketCap)) {
            double sales = sectionRatio(mainText, "Profit & Loss", "Sales");
            if (nan(sales) || sales <= 0)
                sales = sectionRatio(mainText, "Profit & Loss", "Revenue from operations");
            if (nan(sales) || sales <= 0)
                sales = sectionRatio(mainText, "Profit & Loss", "Revenue");
            if (!nan(sales) && sales > 0) {
                priceSales = marketCap / sales;
                logger.info("[ScreenerCheck] [{}] Computed P/S={} (mktCap={} sales={})",
                        symbol, f(priceSales), (long) marketCap, (long) sales);
            } else {
                logger.warn("[ScreenerCheck] [{}] P/S: no revenue row found in P&L section", symbol);
            }
        }

        // EV/EBITDA: (Market Cap + Debt) / (Operating Profit + Depreciation).
        // Cash is not a separate Balance Sheet line on Screener, so EV = MCap + Debt.
        if (nan(evEbitda) && !nan(marketCap)) {
            double op  = sectionRatio(mainText, "Profit & Loss", "Operating Profit");
            double dep = sectionRatio(mainText, "Profit & Loss", "Depreciation");
            double bor = sectionRatio(mainText, "Balance Sheet", "Borrowings");
            if (!nan(op) && !nan(dep)) {
                double ebitda = op + dep;
                double ev     = marketCap + (nan(bor) ? 0 : bor);
                if (ebitda > 0) {
                    evEbitda = ev / ebitda;
                    logger.info("[ScreenerCheck] [{}] Computed EV/EBITDA={} (ev={} ebitda={})",
                            symbol, f(evEbitda), (long) ev, (long) ebitda);
                }
            }
        }

        // Pledged: fetch from NSE shareholding pattern API.
        if (nan(pledged)) {
            pledged = fetchPledgedFromNse(symbol);
        }

        // Industry PE: market-cap-weighted average from Screener's public sector page.
        if (nan(industryPE)) {
            industryPE = fetchSectorIndustryPE(mainHtml, symbol);
        }

        logger.info("[ScreenerCheck] [{}] promoter={} pledged={} debtEq={} indPE={}",
                symbol, promoter, pledged, debtEquity, industryPE);

        // ── Derived ──────────────────────────────────────────────────────────
        double peg = (!nan(stockPE) && !nan(profitGrowth5Y) && profitGrowth5Y > 0)
                ? stockPE / profitGrowth5Y : Double.NaN;

        // Score denominator excludes criteria that are still N/A after all fallbacks.
        int naCount = ((nan(stockPE) || nan(industryPE)) ? 1 : 0)
                    + (nan(pledged)    ? 1 : 0)
                    + (nan(priceSales) ? 1 : 0)
                    + (nan(evEbitda)   ? 1 : 0);
        int evaluatable = 13 - naCount;

        StringBuilder sb = new StringBuilder();
        sb.append("\n🔍 Screener.in Check — ").append(symbol).append("\n");

        int pass = 0;
        pass += row(sb, "Market Cap",   f(marketCap) + " Cr",               marketCap > 1000,                                         "> ₹1,000 Cr", nan(marketCap));
        pass += row(sb, "PEG",          f(peg),                              peg < 1,                                                   "< 1",         nan(peg));
        pass += row(sb, "PE / Ind PE",  f(stockPE) + " / " + f(industryPE), !nan(stockPE) && !nan(industryPE) && stockPE < industryPE, "PE < Ind PE", nan(stockPE) || nan(industryPE));
        pass += row(sb, "ROE",          f(roe) + "%",                        roe > 20,                                                  "> 20%",       nan(roe));
        pass += row(sb, "ROCE",         f(roce) + "%",                       roce > 15,                                                 "> 15%",       nan(roce));
        pass += row(sb, "Debt/Equity",  f(debtEquity),                       debtEquity < 0.5,                                          "< 0.5",       nan(debtEquity));
        pass += row(sb, "Promoter",     f(promoter) + "%",                   promoter > 50,                                             "> 50%",       nan(promoter));
        pass += row(sb, "Sales Gr 3Y",  f(salesGrowth3Y) + "%",              salesGrowth3Y > 15,                                        "> 15%",       nan(salesGrowth3Y));
        pass += row(sb, "Profit Gr 5Y", f(profitGrowth5Y) + "%",             profitGrowth5Y > 15,                                       "> 15%",       nan(profitGrowth5Y));
        pass += row(sb, "Pledged",      f(pledged) + "%",                    pledged < 1,                                               "< 1%",        nan(pledged));
        pass += row(sb, "OPM",          f(opm) + "%",                        opm > 15,                                                  "> 15%",       nan(opm));
        pass += row(sb, "Price/Sales",  f(priceSales),                       priceSales < 10,                                           "< 10",        nan(priceSales));
        pass += row(sb, "EV/EBITDA",    f(evEbitda),                         evEbitda < 25,                                             "< 25",        nan(evEbitda));

        String verdict = pass >= Math.round(evaluatable * 0.88f) ? "Strong Buy"
                       : pass >= Math.round(evaluatable * 0.67f) ? "Moderate"
                       : "Avoid";
        sb.append("Score: ").append(pass).append("/").append(evaluatable)
          .append(" — ").append(verdict);
        return sb.toString();
    }

    /** Appends one criteria row; returns 1 if criterion passes, 0 otherwise. */
    private int row(StringBuilder sb, String label, String value,
                    boolean passes, String threshold, boolean na) {
        String icon = na ? "❓" : passes ? "✅" : "❌";
        if (na) value = "N/A";
        sb.append(icon).append(" ").append(label).append(": ").append(value)
          .append(" (").append(threshold).append(")\n");
        return (!na && passes) ? 1 : 0;
    }

    // ── Parsing helpers ───────────────────────────────────────────────────────

    /** First number found immediately after {@code label} in plain text. */
    private double after(String text, String label) {
        int idx = text.indexOf(label);
        if (idx < 0) return Double.NaN;
        String win = text.substring(idx + label.length(),
                Math.min(idx + label.length() + 80, text.length()));
        Matcher m = Pattern.compile("([\\d,]+(?:\\.\\d+)?)").matcher(win);
        if (m.find()) {
            try { return Double.parseDouble(m.group(1).replace(",", "")); }
            catch (NumberFormatException ignored) {}
        }
        return Double.NaN;
    }

    /** Value for a specific period under a "Compounded X Growth" heading. */
    private double growth(String text, String growthType, String period) {
        String heading = "Compounded " + growthType;
        int hIdx = text.indexOf(heading);
        if (hIdx < 0) return Double.NaN;
        String block = text.substring(hIdx, Math.min(hIdx + 400, text.length()));
        int pIdx = block.indexOf(period);
        if (pIdx < 0) return Double.NaN;
        String after = block.substring(pIdx + period.length(),
                Math.min(pIdx + period.length() + 30, block.length()));
        Matcher m = Pattern.compile("([\\-\\d\\.]+)").matcher(after);
        if (m.find()) {
            try { return Double.parseDouble(m.group(1)); }
            catch (NumberFormatException ignored) {}
        }
        return Double.NaN;
    }

    /**
     * Most recent (last) numeric value in the row identified by {@code rowLabel}.
     * Screener renders years oldest→newest; the last number is TTM / most recent annual.
     * Stops at any token containing 2+ consecutive letters (signals next row label or section).
     */
    private double ratioLatest(String text, String rowLabel) {
        int idx = text.indexOf(rowLabel);
        if (idx < 0) return Double.NaN;
        String win = text.substring(idx + rowLabel.length(),
                Math.min(idx + rowLabel.length() + 200, text.length()));
        String[] tokens = win.split("\\s+");
        double last = Double.NaN;
        for (String tok : tokens) {
            if (tok.matches(".*[A-Za-z]{2,}.*")) break;
            String clean = tok.replaceAll("[^\\d\\.\\-]", "");
            if (clean.isEmpty()) continue;
            try { last = Double.parseDouble(clean); } catch (NumberFormatException ignored) {}
        }
        return last;
    }

    /**
     * Like {@link #ratioLatest} but restricts the search to a named section of the text.
     * This prevents "Sales" in the Quarterly Results table (which appears earlier in the HTML)
     * from shadowing "Sales" in the annual Profit & Loss table.
     *
     * <p>Screener's page text starts with a navigation tab bar that reads
     * "Profit &amp; Loss Balance Sheet Cash Flow Ratios …". The first occurrence of
     * "Profit &amp; Loss" therefore hits this nav bar, not the financial-data table.
     * We detect this by checking whether "Balance Sheet" immediately follows the
     * marker (within 60 chars) and, if so, skip that occurrence and try the next one.
     *
     * @param sectionMarker text that marks the start of the section (e.g. "Profit & Loss")
     * @param rowLabel      the row label to find within that section
     */
    private double sectionRatio(String text, String sectionMarker, String rowLabel) {
        int sIdx = -1;
        int searchFrom = 0;
        while (true) {
            int found = text.indexOf(sectionMarker, searchFrom);
            if (found < 0) break;
            // Nav-tab pattern: "Profit & Loss Balance Sheet Cash Flow …" — skip it
            String peek = text.substring(found + sectionMarker.length(),
                    Math.min(found + sectionMarker.length() + 60, text.length()));
            if (peek.contains("Balance Sheet")) {
                searchFrom = found + 1;
                continue;
            }
            sIdx = found;
            break;
        }
        if (sIdx < 0) return Double.NaN;
        // 3 000 chars covers ~9 years of annual data for any row
        String section = text.substring(sIdx, Math.min(sIdx + 3000, text.length()));
        return ratioLatest(section, rowLabel);
    }

    private boolean nan(double v) { return Double.isNaN(v); }

    private String f(double v) {
        if (Double.isNaN(v)) return "N/A";
        if (v == Math.floor(v) && !Double.isInfinite(v) && Math.abs(v) < 1_000_000)
            return String.valueOf((long) v);
        return String.format("%.2f", v);
    }
}
