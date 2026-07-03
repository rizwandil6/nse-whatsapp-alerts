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
 */
@Component
public class ScreenerCheckService {

    private static final Logger logger = LoggerFactory.getLogger(ScreenerCheckService.class);

    @Value("${screener.username:}")
    private String username;

    @Value("${screener.password:}")
    private String password;

    private final CookieManager cookieManager = new CookieManager();
    private final HttpClient httpClient;
    private volatile boolean loggedIn = false;

    public ScreenerCheckService() {
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

            // Main page — has Market Cap, Stock P/E, ROCE, ROE, OPM, growth rates
            String mainHtml = fetchPage(symbol, "");
            if (mainHtml == null || mainHtml.isBlank()) return "";
            logger.info("[ScreenerCheck] main page fetched ({} chars) for {}", mainHtml.length(), symbol);
            String mainText = htmlToText(mainHtml);

            // The actual quick_ratios endpoint uses a NUMERIC company ID, not the symbol.
            // The ID is embedded in the main page HTML and can be extracted via regex.
            // Endpoint: https://www.screener.in/api/company/{ID}/quick_ratios/
            String companyId = extractCompanyId(mainHtml);
            String qrHtml = null;
            if (companyId != null) {
                String referer = "https://www.screener.in/company/" + enc(symbol) + "/";
                qrHtml = fetchAbsoluteUrl(
                        "https://www.screener.in/api/company/" + companyId + "/quick_ratios/",
                        referer);
                logger.info("[ScreenerCheck] [{}] companyId={} qrHtml={} chars",
                        symbol, companyId, qrHtml != null ? qrHtml.length() : 0);
            } else {
                logger.warn("[ScreenerCheck] [{}] could not extract numeric company ID", symbol);
            }

            return buildResult(mainText, qrHtml, symbol);
        } catch (Exception e) {
            logger.warn("[ScreenerCheck] Failed for {}: {}", symbol, e.getMessage());
            return "";
        }
    }

    // ── Login ─────────────────────────────────────────────────────────────────

    private synchronized void ensureLoggedIn() throws Exception {
        if (loggedIn) return;

        // Step 1: GET login page to obtain CSRF token
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

        // Step 2: POST credentials
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

        // With followRedirects(NORMAL): a successful login (302 → home) ends up as HTTP 200
        // on the home page, while a failed login stays on /login/ (also 200).
        // Distinguish by checking the final URI — success redirects away from /login/.
        String finalLoginUri = postResp.uri().toString();
        boolean redirectedAway = !finalLoginUri.contains("/login");
        loggedIn = redirectedAway;

        // Log body snippet to diagnose login failures
        String bodySnippet = postResp.body().length() > 300
                ? postResp.body().substring(0, 300) : postResp.body();
        // Redact password just in case it appears in error messages
        bodySnippet = bodySnippet.replaceAll("(?i)password[^<]{0,60}", "password=***");
        logger.info("[ScreenerCheck] Login POST → finalUri={} loggedIn={}", finalLoginUri, loggedIn);
        if (!loggedIn) {
            logger.warn("[ScreenerCheck] Login failed. Body snippet: [{}]", bodySnippet);
        }
    }

    private String extractCsrf(String html) {
        // <input name="csrfmiddlewaretoken" value="TOKEN">  (order may vary)
        Matcher m = Pattern.compile("csrfmiddlewaretoken[^>]+value=[\"']([^\"']+)[\"']").matcher(html);
        if (m.find()) return m.group(1);
        m = Pattern.compile("value=[\"']([^\"']+)[\"'][^>]+csrfmiddlewaretoken").matcher(html);
        if (m.find()) return m.group(1);
        return null;
    }

    private String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    // ── Fetch page ────────────────────────────────────────────────────────────

    /**
     * Extracts Screener's internal numeric company ID from the main page HTML.
     * The ID is embedded in API URLs within the page (e.g. /api/company/6320575/peers/).
     * Company IDs are 5–8 digit numbers.
     */
    private String extractCompanyId(String html) {
        // Most reliable: /api/company/{ID}/ appears in multiple AJAX links on the page
        Matcher m = Pattern.compile("/api/company/(\\d{5,8})/").matcher(html);
        if (m.find()) return m.group(1);
        // Fallback: data attribute on the company container
        m = Pattern.compile("data-company[_-]id=[\"'](\\d+)[\"']").matcher(html);
        if (m.find()) return m.group(1);
        return null;
    }

    /** Fetches an absolute URL with Referer + XHR headers; returns null on non-200. */
    private String fetchAbsoluteUrl(String url, String referer) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("User-Agent", "Mozilla/5.0")
                .header("Referer", referer)
                .header("X-Requested-With", "XMLHttpRequest")
                .header("Accept", "text/html,*/*")
                .timeout(Duration.ofSeconds(20))
                .GET().build();
        HttpResponse<String> resp = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            logger.info("[ScreenerCheck] HTTP {} for {}", resp.statusCode(), url);
            return null;
        }
        return resp.body();
    }

    /**
     * Parses a named ratio from the quick_ratios HTML response.
     * Each entry looks like:
     *   <span class="name">Industry PE</span>
     *   ...
     *   <span class="number">17.7</span>
     */
    private double parseQR(String html, String ratioName) {
        // Find the ratio name label, then look for the first <span class="number"> after it.
        String escaped = Pattern.quote(ratioName);
        Matcher m = Pattern.compile(
                "class=\"name\"[^>]*>\\s*" + escaped + "\\s*</span>" +
                ".*?class=\"number\"[^>]*>([\\d,\\.]+)</span>",
                Pattern.DOTALL).matcher(html);
        if (m.find()) {
            try { return Double.parseDouble(m.group(1).replace(",", "")); }
            catch (NumberFormatException ignored) {}
        }
        return Double.NaN;
    }

    /** Fetches https://www.screener.in/company/{SYMBOL}/{subPath} */
    private String fetchPage(String symbol, String subPath) throws Exception {
        String companyUrl = "https://www.screener.in/company/" + enc(symbol) + "/";
        String url = companyUrl + subPath;

        HttpRequest.Builder req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("User-Agent", "Mozilla/5.0")
                .header("Referer", companyUrl)
                .timeout(Duration.ofSeconds(20));

        // quick_ratios/ and similar are AJAX endpoints — must identify as XHR
        if (!subPath.isEmpty()) {
            req.header("X-Requested-With", "XMLHttpRequest")
               .header("Accept", "*/*");
        }

        HttpResponse<String> resp = httpClient.send(req.GET().build(),
                HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            logger.info("[ScreenerCheck] HTTP {} for {}{}", resp.statusCode(), symbol, subPath);
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

    // ── 13-criteria evaluation ────────────────────────────────────────────────

    private String buildResult(String mainText, String qrHtml, String symbol) {

        // ── Main page HTML: Market Cap, Stock P/E, ROCE, ROE, OPM, growth rates ──
        double marketCap      = after(mainText, "Market Cap");
        double stockPE        = after(mainText, "Stock P/E");
        double roce           = after(mainText, "ROCE");
        double roe            = after(mainText, "ROE");
        double salesGrowth3Y  = growth(mainText, "Sales Growth",  "3 Years");
        double profitGrowth5Y = growth(mainText, "Profit Growth", "5 Years");
        double opm            = ratioLatest(mainText, "OPM %");

        // ── /api/company/{ID}/quick_ratios/ (real per-company endpoint) ──
        // Returns HTML <li data-source="quick-ratio"> items with <span class="name"> and
        // <span class="number">. Labels match exactly what Screener shows on the page.
        double debtEquity  = Double.NaN;
        double industryPE  = Double.NaN;
        double promoter    = Double.NaN;
        double pledged     = Double.NaN;
        double evEbitda    = Double.NaN;
        double priceSales  = Double.NaN;

        if (qrHtml != null && !qrHtml.isBlank()) {
            debtEquity = parseQR(qrHtml, "Debt to equity");
            industryPE = parseQR(qrHtml, "Industry PE");
            promoter   = parseQR(qrHtml, "Promoter holding");
            pledged    = parseQR(qrHtml, "Pledged percentage");
            evEbitda   = parseQR(qrHtml, "EVEBITDA");
            priceSales = parseQR(qrHtml, "Price to Sales");
            logger.info("[ScreenerCheck] [{}] QR → debtEq={} indPE={} promo={} pledged={} ev={} ps={}",
                    symbol, debtEquity, industryPE, promoter, pledged, evEbitda, priceSales);
        }

        // ── Fallback to server-rendered mainText for critical fields ──
        // Promoter: "Promoters + 73.91% ..." is always server-rendered.
        if (nan(promoter)) promoter = after(mainText, "Promoters");
        // Debt/Equity: compute from balance sheet if API didn't provide it.
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

        logger.info("[ScreenerCheck] [{}] promoter={} pledged={} debtEq={} indPE={}",
                symbol, promoter, pledged, debtEquity, industryPE);

        // ── Derived ──
        double peg = (!nan(stockPE) && !nan(profitGrowth5Y) && profitGrowth5Y > 0)
                ? stockPE / profitGrowth5Y : Double.NaN;

        // 4 criteria are JS-rendered on Screener and cannot be obtained via plain HTTP:
        // PE/Ind PE (industryPE), Pledged, Price/Sales, EV/EBITDA.
        // Score denominator = evaluatable criteria only so the verdict is meaningful.
        int naCount = ((nan(stockPE) || nan(industryPE)) ? 1 : 0)
                    + (nan(pledged)    ? 1 : 0)
                    + (nan(priceSales) ? 1 : 0)
                    + (nan(evEbitda)   ? 1 : 0);
        int evaluatable = 13 - naCount;   // currently 9

        StringBuilder sb = new StringBuilder();
        sb.append("\n🔍 Screener.in Check — ").append(symbol).append("\n");

        int pass = 0;
        pass += row(sb, "Market Cap",    f(marketCap) + " Cr",               marketCap > 1000,                                           "> ₹1,000 Cr",   nan(marketCap));
        pass += row(sb, "PEG",           f(peg),                              peg < 1,                                                     "< 1",           nan(peg));
        pass += row(sb, "PE / Ind PE",   f(stockPE) + " / " + f(industryPE), !nan(stockPE) && !nan(industryPE) && stockPE < industryPE,   "PE < Ind PE",   nan(stockPE) || nan(industryPE));
        pass += row(sb, "ROE",           f(roe) + "%",                        roe > 20,                                                    "> 20%",         nan(roe));
        pass += row(sb, "ROCE",          f(roce) + "%",                       roce > 15,                                                   "> 15%",         nan(roce));
        pass += row(sb, "Debt/Equity",   f(debtEquity),                       debtEquity < 0.5,                                            "< 0.5",         nan(debtEquity));
        pass += row(sb, "Promoter",      f(promoter) + "%",                   promoter > 50,                                               "> 50%",         nan(promoter));
        pass += row(sb, "Sales Gr 3Y",   f(salesGrowth3Y) + "%",              salesGrowth3Y > 15,                                          "> 15%",         nan(salesGrowth3Y));
        pass += row(sb, "Profit Gr 5Y",  f(profitGrowth5Y) + "%",             profitGrowth5Y > 15,                                         "> 15%",         nan(profitGrowth5Y));
        pass += row(sb, "Pledged",       f(pledged) + "%",                    pledged < 1,                                                 "< 1%",          nan(pledged));
        pass += row(sb, "OPM",           f(opm) + "%",                        opm > 15,                                                    "> 15%",         nan(opm));
        pass += row(sb, "Price/Sales",   f(priceSales),                       priceSales < 10,                                             "< 10",          nan(priceSales));
        pass += row(sb, "EV/EBITDA",     f(evEbitda),                         evEbitda < 25,                                               "< 25",          nan(evEbitda));

        // Thresholds proportional to evaluatable count (≥88% = Strong Buy, ≥67% = Moderate)
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

    /** First number found immediately after `label` in plain text. */
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
     * Most recent (last) numeric value in the ratios table row identified by `rowLabel`.
     * Screener.in shows up to 10 years + TTM per row; we take the last number.
     */
    private double ratioLatest(String text, String rowLabel) {
        int idx = text.indexOf(rowLabel);
        if (idx < 0) return Double.NaN;
        String win = text.substring(idx + rowLabel.length(),
                Math.min(idx + rowLabel.length() + 200, text.length()));
        String[] tokens = win.split("\\s+");
        double last = Double.NaN;
        for (String tok : tokens) {
            // Stop if we hit a token that looks like a new row label (has letters, length > 2)
            if (tok.matches(".*[A-Za-z]{2,}.*")) break;
            String clean = tok.replaceAll("[^\\d\\.\\-]", "");
            if (clean.isEmpty()) continue;
            try { last = Double.parseDouble(clean); } catch (NumberFormatException ignored) {}
        }
        return last;
    }

    private boolean nan(double v) { return Double.isNaN(v); }

    private String f(double v) {
        if (Double.isNaN(v)) return "N/A";
        // Show as integer if no fractional part
        if (v == Math.floor(v) && !Double.isInfinite(v) && Math.abs(v) < 1_000_000)
            return String.valueOf((long) v);
        return String.format("%.2f", v);
    }
}
