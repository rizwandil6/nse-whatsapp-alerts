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
            String mainText = htmlToText(mainHtml);

            // quick_ratios/ — the AJAX endpoint that loads Debt/Equity, Industry PE,
            // Promoter Holding, Pledged (these are NOT in the initial HTML)
            String qrHtml  = fetchPage(symbol, "quick_ratios/");
            String qrText  = (qrHtml != null && !qrHtml.isBlank()) ? htmlToText(qrHtml) : "";
            logger.debug("[ScreenerCheck] quick_ratios snippet: {}", qrText.length() > 200 ? qrText.substring(0, 200) : qrText);

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
                        .header("User-Agent", "Mozilla/5.0")
                        .header("Content-Type", "application/x-www-form-urlencoded")
                        .header("Referer", loginUrl)
                        .timeout(Duration.ofSeconds(15))
                        .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString());

        loggedIn = (postResp.statusCode() == 200 || postResp.statusCode() == 302);
        logger.info("[ScreenerCheck] Login: HTTP {} → loggedIn={}", postResp.statusCode(), loggedIn);
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

    /** Fetches https://www.screener.in/company/{SYMBOL}/{subPath} */
    private String fetchPage(String symbol, String subPath) throws Exception {
        String url = "https://www.screener.in/company/" + enc(symbol) + "/" + subPath;
        HttpResponse<String> resp = httpClient.send(
                HttpRequest.newBuilder().uri(URI.create(url))
                        .header("User-Agent", "Mozilla/5.0")
                        .header("Referer", "https://www.screener.in/")
                        .timeout(Duration.ofSeconds(20)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            logger.warn("[ScreenerCheck] HTTP {} for {}{}", resp.statusCode(), symbol, subPath);
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
        double stockPE        = after(mainText, "Stock P/E");   // in main HTML, NOT in quick_ratios
        double roce           = after(mainText, "ROCE");
        double roe            = after(mainText, "ROE");
        double salesGrowth3Y  = growth(mainText, "Sales Growth",  "3 Years");
        double profitGrowth5Y = growth(mainText, "Profit Growth", "5 Years");
        double opm            = ratioLatest(mainText, "OPM %");

        // ── quick_ratios/ AJAX: ALL fields loaded dynamically (not in initial HTML) ──
        // Labels exactly as seen in DevTools preview:
        // "Debt to equity 0.02 ... Industry PE 17.7 ... Promoter holding 65.2 %
        //  Pledged percentage 0.00 % EVEBITDA 10.0 Price to Sales 1.49"
        double debtEquity  = after(qrText, "Debt to equity");
        double industryPE  = after(qrText, "Industry PE");
        double promoter    = after(qrText, "Promoter holding");
        double pledged     = after(qrText, "Pledged percentage");
        double evEbitda    = after(qrText, "EVEBITDA");         // label is "EVEBITDA", not "EV / EBITDA"
        double priceSales  = after(qrText, "Price to Sales");

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
