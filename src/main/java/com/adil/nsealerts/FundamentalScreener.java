package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Component
public class FundamentalScreener {
    private static final Logger logger = LoggerFactory.getLogger(FundamentalScreener.class);

    // Screener.in endpoints (fundamental data)
    private static final String SCREENER_LOGIN_URL = "https://www.screener.in/login/";
    private static final String SCREENER_SEARCH_URL = "https://www.screener.in/api/company/search/?q=%s&v=3&fts=1";
    private static final String SCREENER_COMPANY_CONSOLIDATED_URL = "https://www.screener.in/company/%s/consolidated/";
    private static final String SCREENER_COMPANY_URL = "https://www.screener.in/company/%s/";

    // Yahoo Finance v8 chart (technical analysis only — works without auth)
    private static final String CHART_URL_TEMPLATE = "https://query1.finance.yahoo.com/v8/finance/chart/%s.NS?interval=1d&range=1y";

    private static final String USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    @Value("${screener.username:}")
    private String screenerUsername;

    @Value("${screener.password:}")
    private String screenerPassword;

    private volatile Map<String, String> screenerCookies;

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public FundamentalScreener() {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(5000);
        requestFactory.setReadTimeout(10000);
        this.restTemplate = new RestTemplate(requestFactory);
    }

    public FundamentalResult analyze(String symbol) {
        FundamentalResult result = new FundamentalResult();
        String lookupText = symbol == null ? "" : symbol.trim();
        if (lookupText.isBlank()) {
            return unavailable(result, "⚠️ Fundamental data unavailable for " + lookupText);
        }
        try {
            String screenerSymbol = resolveScreenerSymbol(lookupText);
            if (screenerSymbol == null || screenerSymbol.isBlank()) {
                return unavailable(result, "⚠️ Fundamental data unavailable for " + lookupText);
            }
            result.setSymbol(screenerSymbol);
            boolean parsed = fetchAndParseScreener(screenerSymbol, result);
            if (!parsed) {
                return unavailable(result, "⚠️ Fundamental data unavailable for " + screenerSymbol);
            }
            fetchTechnicalData(screenerSymbol, result);
            return result;
        } catch (Exception e) {
            logger.warn("Fundamental analysis failed for {}", lookupText, e);
            return unavailable(result, "⚠️ Fundamental data unavailable for " + lookupText);
        }
    }

    // ── Screener.in session ───────────────────────────────────────────────────

    private synchronized Map<String, String> ensureScreenerSession() throws IOException {
        if (screenerCookies != null && !screenerCookies.isEmpty()) {
            return screenerCookies;
        }
        return loginToScreener();
    }

    private Map<String, String> loginToScreener() throws IOException {
        org.jsoup.Connection.Response loginPage = Jsoup.connect(SCREENER_LOGIN_URL)
                .userAgent(USER_AGENT)
                .method(org.jsoup.Connection.Method.GET)
                .timeout(10000)
                .execute();
        String csrfToken = loginPage.parse().select("input[name=csrfmiddlewaretoken]").val();
        Map<String, String> initialCookies = new HashMap<>(loginPage.cookies());

        org.jsoup.Connection.Response loginResponse = Jsoup.connect(SCREENER_LOGIN_URL)
                .userAgent(USER_AGENT)
                .method(org.jsoup.Connection.Method.POST)
                .cookies(initialCookies)
                .data("username", screenerUsername)
                .data("password", screenerPassword)
                .data("csrfmiddlewaretoken", csrfToken)
                .data("next", "/")
                .header("Referer", SCREENER_LOGIN_URL)
                .followRedirects(true)
                .timeout(10000)
                .execute();

        Map<String, String> cookies = new HashMap<>(loginResponse.cookies());
        if (!cookies.containsKey("sessionid")) {
            throw new IllegalStateException("Screener.in login failed — no sessionid in response");
        }
        logger.info("Screener.in login successful");
        screenerCookies = cookies;
        return cookies;
    }

    // ── Symbol resolution ─────────────────────────────────────────────────────

    String resolveScreenerSymbol(String companyName) {
        try {
            String encoded = URLEncoder.encode(companyName, StandardCharsets.UTF_8);
            Map<String, String> cookies = ensureScreenerSession();
            org.jsoup.Connection.Response response = Jsoup.connect(
                            String.format(SCREENER_SEARCH_URL, encoded))
                    .userAgent(USER_AGENT)
                    .cookies(cookies)
                    .ignoreContentType(true)
                    .timeout(10000)
                    .execute();
            JsonNode results = objectMapper.readTree(response.body());
            if (results.isArray() && !results.isEmpty()) {
                String url = results.get(0).path("url").asText("");
                if (url.startsWith("/company/")) {
                    // URL format: "/company/IRCON/" or "/company/APEXECO-SM/consolidated/"
                    // Take only the first path segment after "/company/" to avoid appending "consolidated"
                    String afterCompany = url.substring("/company/".length());
                    int nextSlash = afterCompany.indexOf('/');
                    String sym = (nextSlash >= 0 ? afterCompany.substring(0, nextSlash) : afterCompany).trim();
                    if (!sym.isBlank()) {
                        logger.debug("Resolved '{}' → screener symbol '{}'", companyName, sym);
                        return sym;
                    }
                }
            }
        } catch (Exception e) {
            logger.warn("Failed to resolve screener symbol for '{}': {}", companyName, e.getMessage());
            screenerCookies = null;
        }
        return null;
    }

    // ── Screener.in page fetch & parse ────────────────────────────────────────

    boolean fetchAndParseScreener(String symbol, FundamentalResult result) {
        Document doc = fetchScreenerPage(symbol, true);
        if (doc == null) {
            doc = fetchScreenerPage(symbol, false);
        }
        if (doc == null) {
            return false;
        }
        parseScreenerFundamentals(doc, result);
        result.setAvailable(true);
        return true;
    }

    private Document fetchScreenerPage(String symbol, boolean consolidated) {
        String url = consolidated
                ? String.format(SCREENER_COMPANY_CONSOLIDATED_URL, symbol)
                : String.format(SCREENER_COMPANY_URL, symbol);
        try {
            Map<String, String> cookies = ensureScreenerSession();
            org.jsoup.Connection.Response response = Jsoup.connect(url)
                    .userAgent(USER_AGENT)
                    .cookies(cookies)
                    .followRedirects(true)
                    .timeout(10000)
                    .execute();
            if (response.url().toString().contains("/login")) {
                logger.info("Screener.in session expired — re-logging in");
                screenerCookies = null;
                Map<String, String> fresh = loginToScreener();
                response = Jsoup.connect(url)
                        .userAgent(USER_AGENT)
                        .cookies(fresh)
                        .followRedirects(true)
                        .timeout(10000)
                        .execute();
            }
            Document doc = response.parse();
            if (doc.select("#top-ratios li, .company-ratios li").isEmpty()) {
                return null;
            }
            return doc;
        } catch (Exception e) {
            logger.debug("Could not fetch screener page for {}: {}", symbol, e.getMessage());
            return null;
        }
    }

    private void parseScreenerFundamentals(Document doc, FundamentalResult result) {
        Map<String, String> ratios = parseKeyRatios(doc);

        Double marketCap = parseNum(ratios.getOrDefault("Market Cap", ratios.getOrDefault("Mkt Cap", "")));
        if (marketCap != null) {
            result.setMarketCapCr(marketCap);
            result.setMarketCapCategory(marketCapCategory(marketCap));
        }

        Double pe = parseNum(ratios.getOrDefault("Stock P/E", ratios.getOrDefault("P/E", "")));
        Double industryPe = parseNum(ratios.getOrDefault("Industry P/E", ""));
        if (pe != null) {
            result.setTrailingPe(pe);
            result.setIndustryPe(industryPe);
            result.setPeRating(peRating(pe));
            result.setPeComparison(industryPe != null ? String.format("vs Industry PE %.2f", industryPe) : "");
        }

        Double roce = parsePct(ratios.getOrDefault("ROCE", ""));
        if (roce != null) {
            result.setRocePercent(roce);
            result.setRoceRating(roceRating(roce));
        }

        Double bookValue = parseNum(ratios.getOrDefault("Book Value", ""));
        Double currentPrice = parseNum(ratios.getOrDefault("Current Price", ""));
        result.setBookValue(bookValue);
        result.setCurrentPrice(currentPrice);
        if (bookValue != null && bookValue > 0 && currentPrice != null) {
            double ptb = currentPrice / bookValue;
            result.setPriceToBookRatio(ptb);
            result.setBookValueRating(bookValueRating(ptb));
        }

        result.setTrailingEps(parseNum(ratios.getOrDefault("EPS", "")));
        parseQuarterlyResults(doc, result);
        parseBalanceSheet(doc, result, marketCap);
        parseShareholding(doc, result);
        parseCompoundedSalesGrowth(doc, result);
    }

    private void parseCompoundedSalesGrowth(Document doc, FundamentalResult result) {
        // Screener renders compounded growth in small cards: <ul> inside a <div class="card"> with heading "Compounded Sales Growth"
        for (Element card : doc.select("div.card, section")) {
            String heading = card.select("h3, h2, .card-header").text().trim();
            if (heading.toLowerCase().contains("compounded sales growth")) {
                for (Element li : card.select("li")) {
                    String label = li.select(".name, span:first-child").text().trim().toLowerCase();
                    String value = li.select(".value, span:last-child").text().trim();
                    Double pct = parsePct(value);
                    if (label.contains("10")) result.setSalesGrowth10Y(pct);
                    else if (label.contains("5")) result.setSalesGrowth5Y(pct);
                    else if (label.contains("3")) result.setSalesGrowth3Y(pct);
                    else if (label.contains("ttm")) result.setSalesGrowthTtm(pct);
                }
                return;
            }
        }
    }

    private Map<String, String> parseKeyRatios(Document doc) {
        Map<String, String> ratios = new HashMap<>();
        for (Element li : doc.select("#top-ratios li, .company-ratios li")) {
            Element nameEl = li.select(".name").first();
            // Use ownText() to avoid child-span text (e.g. "₹ Cr.") being included in the key
            String name = nameEl != null ? nameEl.ownText().trim().replaceAll("\\s*\\(.*?\\)", "").trim() : "";
            Element valEl = li.select(".value, .number").first();
            String value = valEl != null ? valEl.text().trim() : "";
            if (!name.isBlank() && !value.isBlank()) {
                ratios.put(name, value);
            }
        }
        return ratios;
    }

    private void parseQuarterlyResults(Document doc, FundamentalResult result) {
        Element section = doc.getElementById("quarters");
        if (section == null) return;
        for (Element row : section.select("table.data-table tbody tr")) {
            Elements cells = row.select("td");
            if (cells.isEmpty()) continue;
            String label = cells.get(0).text().trim().toLowerCase();
            if (label.startsWith("sales") || label.startsWith("revenue from operations")) {
                List<Double> vals = lastThreeValues(cells);
                if (!vals.isEmpty()) {
                    result.setQuarterlyRevenueCr(vals);
                    result.setQuarterlyRevenueTrend(isIncreasing(vals) ? "✅ Growing" : "⚠️ Declining");
                }
            } else if (label.startsWith("net profit") || label.startsWith("profit after tax")) {
                List<Double> vals = lastThreeValues(cells);
                if (!vals.isEmpty()) {
                    result.setQuarterlyNetProfitCr(vals);
                    result.setQuarterlyNetProfitTrend(isIncreasing(vals) ? "✅ Growing" : "⚠️ Declining");
                }
            }
        }
    }

    private void parseBalanceSheet(Document doc, FundamentalResult result, Double marketCapCr) {
        Element section = doc.getElementById("balance-sheet");
        if (section == null) return;
        Double totalDebt = null, reserves = null, totalAssets = null;
        for (Element row : section.select("table.data-table tbody tr")) {
            Elements cells = row.select("td");
            if (cells.isEmpty()) continue;
            String label = cells.get(0).text().trim().toLowerCase();
            if (label.startsWith("borrowings")) totalDebt = latestValue(cells);
            else if (label.startsWith("reserves")) reserves = latestValue(cells);
            else if (label.startsWith("total assets") || label.startsWith("total liabilities")) totalAssets = latestValue(cells);
        }
        if (totalDebt != null) {
            result.setTotalDebtCr(totalDebt);
            if (marketCapCr != null) result.setDebtVsMarketCapRating(totalDebt < marketCapCr ? "✅ Safe" : "❌ High");
            if (reserves != null) result.setDebtVsReserveRating(totalDebt < reserves ? "✅ Can clear" : "❌ High");
            if (totalAssets != null && totalAssets > 0) {
                double dta = (totalDebt / totalAssets) * 100.0;
                result.setDebtToAssetsPercent(dta);
                result.setDebtToAssetsRating(dta < 33.0 ? "✅ Halal & Safe" : "❌");
            }
        }
    }

    private void parseShareholding(Document doc, FundamentalResult result) {
        Element section = doc.getElementById("shareholding");
        if (section == null) return;
        for (Element row : section.select("table.data-table tbody tr")) {
            Elements cells = row.select("td");
            if (cells.isEmpty()) continue;
            if (cells.get(0).text().trim().toLowerCase().startsWith("promoters")) {
                Double pct = parsePct(cells.get(cells.size() - 1).text().trim());
                if (pct != null) {
                    result.setPromoterHoldingPercent(pct);
                    result.setPromoterHoldingRating(
                            pct >= 50.0 ? "✅ Strong" : pct >= 35.0 ? "🟡 Moderate" : "⚠️ Low");
                }
                break;
            }
        }
    }

    // ── Yahoo Finance chart (technical only) ──────────────────────────────────

    private void fetchTechnicalData(String screenerSymbol, FundamentalResult result) {
        try {
            JsonNode chartRoot = readChartJson(String.format(CHART_URL_TEMPLATE, screenerSymbol));
            if (chartRoot == null) return;
            JsonNode chartResult = firstArrayItem(chartRoot.path("chart").path("result"));
            if (chartResult != null) populateTechnicalFields(result, chartResult);
        } catch (Exception e) {
            logger.debug("Chart data unavailable for {}: {}", screenerSymbol, e.getMessage());
        }
    }

    private JsonNode readChartJson(String url) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set("User-Agent", USER_AGENT);
            headers.set("Accept", "application/json, text/plain, */*");
            ResponseEntity<String> response = restTemplate.exchange(
                    URI.create(url), HttpMethod.GET, new HttpEntity<>(headers), String.class);
            String body = response.getBody();
            if (body == null || body.isBlank()) return null;
            return objectMapper.readTree(body);
        } catch (Exception e) {
            logger.debug("Failed to fetch chart data from {}: {}", url, e.getMessage());
            return null;
        }
    }

    // ── Parse helpers ─────────────────────────────────────────────────────────

    private List<Double> lastThreeValues(Elements cells) {
        List<Double> all = new ArrayList<>();
        for (int i = 1; i < cells.size(); i++) {
            Double v = parseNum(cells.get(i).text().trim());
            if (v != null) all.add(v);
        }
        if (all.size() < 2) return Collections.emptyList();
        return all.subList(Math.max(0, all.size() - 3), all.size());
    }

    private Double latestValue(Elements cells) {
        for (int i = cells.size() - 1; i >= 1; i--) {
            Double v = parseNum(cells.get(i).text().trim());
            if (v != null) return v;
        }
        return null;
    }

    private Double parseNum(String text) {
        if (text == null || text.isBlank() || text.equals("-") || text.equals("\u2014")) return null;
        String cleaned = text
                .replace("\u20B9", "")           // strip ₹ rupee symbol
                .replaceAll("[,\\s]", "")
                .replace("Cr.", "").replace("Cr", "").replace("%", "");
        try { return Double.parseDouble(cleaned); } catch (NumberFormatException e) { return null; }
    }

    private Double parsePct(String text) {
        if (text == null || text.isBlank()) return null;
        String cleaned = text.replaceAll("[,\\s%]", "");
        try { return Double.parseDouble(cleaned); } catch (NumberFormatException e) { return null; }
    }


    private void populateTechnicalFields(FundamentalResult result, JsonNode chartResult) {
        List<Double> closes = chartCloses(chartResult);
        if (closes.isEmpty()) {
            return;
        }

        Double ema200 = ema(closes, 200);
        if (ema200 != null) {
            result.setEma200(ema200);
            Double latestClose = closes.get(closes.size() - 1);
            result.setEma200Rating(latestClose > ema200 ? "✅ Above 200 EMA" : "❌ Below 200 EMA");
        }

        Double rsi14 = rsi(closes, 14);
        if (rsi14 != null) {
            result.setRsi14(rsi14);
            result.setRsiRating(rsi14 >= 30.0 && rsi14 <= 60.0
                    ? String.format("✅ In Range (%.2f)", rsi14)
                    : String.format("⚠️ Out of Range (%.2f)", rsi14));
        }

        Double high52 = max(closes);
        if (high52 != null) {
            result.setFiftyTwoWeekHigh(high52);
            Double latestClose = closes.get(closes.size() - 1);
            result.setBreakoutRating(latestClose >= high52 * 0.97 ? "🚀 Near Breakout!" : "➡️ Not near breakout");
        }
    }

    private FundamentalResult unavailable(FundamentalResult result, String message) {
        result.setAvailable(false);
        result.setUnavailableMessage(message);
        return result;
    }

    private JsonNode firstArrayItem(JsonNode node) {
        if (node == null || !node.isArray() || node.isEmpty()) {
            return null;
        }
        return node.get(0);
    }

    private List<Double> chartCloses(JsonNode chartResult) {
        List<Double> closes = new ArrayList<>();
        JsonNode quote = firstArrayItem(chartResult.path("indicators").path("quote"));
        if (quote == null) {
            return closes;
        }
        JsonNode closeArray = quote.path("close");
        if (!closeArray.isArray()) {
            return closes;
        }
        for (JsonNode close : closeArray) {
            if (close != null && !close.isNull()) {
                closes.add(close.asDouble());
            }
        }
        return closes;
    }

    private Double ema(List<Double> values, int period) {
        if (values.size() < period) {
            return null;
        }
        double multiplier = 2.0 / (period + 1.0);
        double ema = 0.0;
        for (int i = 0; i < period; i++) {
            ema += values.get(i);
        }
        ema /= period;
        for (int i = period; i < values.size(); i++) {
            ema = ((values.get(i) - ema) * multiplier) + ema;
        }
        return ema;
    }

    private Double rsi(List<Double> values, int period) {
        if (values.size() <= period) {
            return null;
        }

        double averageGain = 0.0;
        double averageLoss = 0.0;
        for (int i = 1; i <= period; i++) {
            double change = values.get(i) - values.get(i - 1);
            if (change >= 0) {
                averageGain += change;
            } else {
                averageLoss -= change;
            }
        }
        averageGain /= period;
        averageLoss /= period;

        for (int i = period + 1; i < values.size(); i++) {
            double change = values.get(i) - values.get(i - 1);
            double gain = Math.max(change, 0.0);
            double loss = Math.max(-change, 0.0);
            averageGain = ((averageGain * (period - 1)) + gain) / period;
            averageLoss = ((averageLoss * (period - 1)) + loss) / period;
        }

        if (averageLoss == 0.0) {
            return 100.0;
        }
        double relativeStrength = averageGain / averageLoss;
        return 100.0 - (100.0 / (1.0 + relativeStrength));
    }

    private Double max(List<Double> values) {
        if (values.isEmpty()) {
            return null;
        }
        double maximum = Double.NEGATIVE_INFINITY;
        for (Double value : values) {
            if (value != null && value > maximum) {
                maximum = value;
            }
        }
        return maximum == Double.NEGATIVE_INFINITY ? null : maximum;
    }

    private String marketCapCategory(Double marketCapCr) {
        if (marketCapCr == null) {
            return null;
        }
        if (marketCapCr < 500.0) {
            return "🔴 Penny";
        }
        if (marketCapCr < 5000.0) {
            return "🟠 Small Cap";
        }
        if (marketCapCr < 20000.0) {
            return "🟡 Mid Cap";
        }
        return "🔵 Large Cap";
    }

    private String peRating(Double trailingPe) {
        if (trailingPe >= 10.0 && trailingPe <= 15.0) {
            return "✅ Excellent";
        }
        if (trailingPe > 15.0 && trailingPe <= 20.0) {
            return "🟡 OK";
        }
        if (trailingPe > 20.0 && trailingPe <= 30.0) {
            return "⚠️ Market fall alert";
        }
        if (trailingPe > 30.0) {
            return "❌ Avoid";
        }
        return "⚠️ Check";
    }

    private String roceRating(Double roce) {
        if (roce >= 30.0) {
            return "✅✅ Excellent";
        }
        if (roce >= 20.0) {
            return "✅ Very Good";
        }
        if (roce >= 15.0) {
            return "🟡 Good";
        }
        return "❌ Poor";
    }

    private String bookValueRating(Double priceToBookRatio) {
        if (priceToBookRatio < 1.0) {
            return "✅ Below Book Value";
        }
        if (priceToBookRatio <= 3.0) {
            return "🟡 Fair";
        }
        return "⚠️ Premium";
    }

    private boolean isIncreasing(List<Double> values) {
        return values.size() == 3
                && values.get(0) != null && values.get(1) != null && values.get(2) != null
                && values.get(0) < values.get(1)
                && values.get(1) < values.get(2);
    }
}