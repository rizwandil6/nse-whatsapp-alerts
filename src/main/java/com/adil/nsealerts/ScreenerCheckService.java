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

            // The quick_ratios AJAX endpoint is not directly accessible via HTTP without
            // a headless browser (JS-rendered). /user/quick_ratios/ returns the management page.
            // All fields we need are parsed from mainText below (server-rendered HTML).
            String qrText = "";

            return buildResult(mainText, qrText, symbol);
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
     * Scans the company page HTML for the quick_ratios URL.
     * Screener embeds the URL in its JS/HTML because it uses numeric company IDs internally.
     * Patterns tried (Screener may use various formats):
     *   url: '/company/12345/quick_ratios/'
     *   href="/company/12345/quick_ratios/"
     *   "quick_ratios_url": "/company/12345/quick_ratios/"
     */
    private String extractQuickRatiosUrl(String html) {
        // Search for every occurrence of "quick_ratios" in the HTML/JS.
        // On an AUTHENTICATED company page the JS will contain the actual AJAX URL.
        // On an unauthenticated page we only see the /user/quick_ratios/?next=... link.
        int idx = html.indexOf("quick_ratios");
        while (idx >= 0) {
            int start = Math.max(0, idx - 80);
            int end   = Math.min(html.length(), idx + 100);
            String ctx = html.substring(start, end);
            logger.info("[ScreenerCheck] quick_ratios ctx: [{}]", ctx.replace("\n", "\\n").replace("\r", ""));

            // Match URLs that are AJAX data endpoints (under /company/, not /user/)
            Matcher m = Pattern.compile("(/company/[^/\"'\\s]+/(?:consolidated/|standalone/)?quick_ratios/)").matcher(ctx);
            if (m.find()) {
                String path = m.group(1);
                return path.startsWith("http") ? path : "https://www.screener.in" + path;
            }
            idx = html.indexOf("quick_ratios", idx + 1);
        }
        return null;
    }

    /** Fetches an absolute URL, setting the XHR headers and provided Referer. */
    private String fetchAbsoluteUrl(String url, String referer) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("User-Agent", "Mozilla/5.0")
                .header("Referer", referer)
                .header("X-Requested-With", "XMLHttpRequest")
                .header("Accept", "*/*")
                .timeout(Duration.ofSeconds(20))
                .GET().build();

        HttpResponse<String> resp = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            logger.info("[ScreenerCheck] fetchAbsoluteUrl HTTP {} for {}", resp.statusCode(), url);
            return null;
        }
        return resp.body();
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

    private String buildResult(String mainText, String qrText, String symbol) {

        // ── Main page HTML: Market Cap, Stock P/E, ROCE, ROE, OPM, growth rates ──
        double marketCap      = after(mainText, "Market Cap");
        double stockPE        = after(mainText, "Stock P/E");
        double roce           = after(mainText, "ROCE");
        double roe            = after(mainText, "ROE");
        double salesGrowth3Y  = growth(mainText, "Sales Growth",  "3 Years");
        double profitGrowth5Y = growth(mainText, "Profit Growth", "5 Years");
        double opm            = ratioLatest(mainText, "OPM %");

        // qrText is empty — no accessible AJAX endpoint; all fields from mainText.
        double debtEquity  = Double.NaN;
        double industryPE  = Double.NaN;
        double promoter    = Double.NaN;
        double pledged     = Double.NaN;
        double evEbitda    = Double.NaN;   // JS-rendered; will remain N/A
        double priceSales  = Double.NaN;   // JS-rendered; will remain N/A

        // ── Shareholding Pattern (server-rendered) ──
        // "Promoters 73.91 % 73.91 % ..."
        promoter = after(mainText, "Promoters");
        // Pledged sub-row: "Pledged Shares 0.00 %" or "Pledged 0.00 %"
        pledged = after(mainText, "Pledged Shares");
        if (nan(pledged)) pledged = after(mainText, "Pledged shares");
        if (nan(pledged)) pledged = after(mainText, "% Pledged");
        if (nan(pledged)) pledged = after(mainText, "Pledged");

        // ── Debt/Equity: try label first, then compute from balance sheet ──
        debtEquity = after(mainText, "Debt to equity");
        if (nan(debtEquity)) debtEquity = after(mainText, "Debt to Equity");
        if (nan(debtEquity)) {
            // Balance sheet section shows "Borrowings", "Share Capital", "Reserves"
            // as row labels; first number after each label = most-recent annual value.
            double borrowings   = after(mainText, "Borrowings");
            double shareCapital = after(mainText, "Share Capital");
            double reserves     = after(mainText, "Reserves");
            if (!nan(borrowings) && !nan(shareCapital) && !nan(reserves)) {
                double netWorth = shareCapital + reserves;
                if (netWorth > 0) debtEquity = borrowings / netWorth;
                logger.info("[ScreenerCheck] [{}] D/E computed: borrowings={} sc={} res={} → debtEq={}",
                        symbol, borrowings, shareCapital, reserves, debtEquity);
            }
        }

        // ── Industry PE: peers section ──
        industryPE = after(mainText, "Ind. PE");
        if (nan(industryPE)) industryPE = after(mainText, "Ind. P/E");
        if (nan(industryPE)) industryPE = after(mainText, "Industry PE");
        if (nan(industryPE)) industryPE = after(mainText, "Ind PE");
        if (nan(industryPE)) industryPE = after(mainText, "Industry P/E");

        // ── Diagnostic: log mainText context around key labels ──
        logLabelCtx(mainText, symbol, "Promoters",    300);  // shareholding section
        logLabelCtx(mainText, symbol, "Pledged",      200);  // pledged row
        logLabelCtx(mainText, symbol, "Borrowings",   120);  // balance sheet
        logLabelCtx(mainText, symbol, "Ind. PE",      150);  // peers section
        logLabelCtx(mainText, symbol, "Ind. P/E",     100);
        logger.info("[ScreenerCheck] [{}] promoter={} pledged={} debtEq={} indPE={}",
                symbol, promoter, pledged, debtEquity, industryPE);

        // ── Derived ──
        double peg = (!nan(stockPE) && !nan(profitGrowth5Y) && profitGrowth5Y > 0)
                ? stockPE / profitGrowth5Y : Double.NaN;

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

        String verdict = pass >= 11 ? "Strong Buy" : pass >= 8 ? "Moderate" : "Avoid";
        sb.append("Score: ").append(pass).append("/13 — ").append(verdict);
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

    /** Logs the first `window` chars after `label` in mainText (for diagnosis). */
    private void logLabelCtx(String text, String symbol, String label, int window) {
        int i = text.indexOf(label);
        if (i < 0) {
            logger.info("[ScreenerCheck] [{}] '{}' NOT FOUND", symbol, label);
        } else {
            String ctx = text.substring(i, Math.min(i + window, text.length()));
            logger.info("[ScreenerCheck] [{}] '{}' → [{}]", symbol, label, ctx);
        }
    }

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
