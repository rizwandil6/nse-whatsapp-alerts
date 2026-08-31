package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Component
public class PromptRatingService {
    private static final Logger logger = LoggerFactory.getLogger(PromptRatingService.class);
    private final ObjectMapper objectMapper = new ObjectMapper();

    // Switched from Anthropic (claude-haiku-4-5-20251001) to Gemini 2026-08-31 --
    // confirmed live via trading-agents-service that gemini-3.1-flash-lite runs
    // roughly 20-40x cheaper than Haiku for equivalent short classification/summary
    // tasks (this file's three methods are all exactly that: no multi-turn agentic
    // work, just single-prompt-in, short-verdict-out).
    private static final String GEMINI_MODEL = "gemini-3.1-flash-lite";

    @Value("${google.api-key:}")
    private String googleApiKey;

    public AnalysisResult analyze(String companyName, String subject, String link, String documentText) {
        if (googleApiKey != null && !googleApiKey.isBlank()) {
            try {
                return analyzeWithGemini(companyName, subject, link, documentText);
            } catch (Exception e) {
                logger.error("Gemini analysis failed: {}", e.getMessage());
            }
        }
        return fallbackAnalysis(companyName, subject, link, documentText);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Gemini (gemini-3.1-flash-lite) -- shared call helper, see callGemini() below
    // ─────────────────────────────────────────────────────────────────────────

    private AnalysisResult analyzeWithGemini(String companyName, String subject,
                                              String link, String documentText) throws Exception {
        String prompt = buildPrompt(companyName, subject, documentText);
        String content = callGemini(prompt, 600);
        logger.debug("[Gemini] Response: {}", content);
        return parseResponse(content, companyName, link, documentText);
    }

    /**
     * Shared Gemini REST call -- POST https://generativelanguage.googleapis.com/v1beta/
     * models/{model}:generateContent?key=..., body {contents:[{role:"user",parts:[{text}]}]},
     * response text at candidates[0].content.parts[0].text. Auth via ?key= query param
     * (Gemini's documented default) rather than a header -- server-side outbound call,
     * not browser-exposed, so the key appearing in the request URL is an acceptable
     * tradeoff for using the officially documented auth style directly.
     */
    private String callGemini(String prompt, int maxOutputTokens) throws Exception {
        var rootNode = objectMapper.createObjectNode();
        var contents = objectMapper.createArrayNode();
        var content = objectMapper.createObjectNode();
        content.put("role", "user");
        var parts = objectMapper.createArrayNode();
        var part = objectMapper.createObjectNode();
        part.put("text", prompt);
        parts.add(part);
        content.set("parts", parts);
        contents.add(content);
        rootNode.set("contents", contents);
        var generationConfig = objectMapper.createObjectNode();
        generationConfig.put("maxOutputTokens", maxOutputTokens);
        rootNode.set("generationConfig", generationConfig);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("https://generativelanguage.googleapis.com/v1beta/models/"
                        + GEMINI_MODEL + ":generateContent?key=" + googleApiKey))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(rootNode.toString(), StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> response = HttpClient.newHttpClient()
                .send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

        if (response.statusCode() != 200) {
            throw new RuntimeException("Gemini API error: " + response.statusCode() + " " + response.body());
        }

        return objectMapper.readTree(response.body()).at("/candidates/0/content/parts/0/text").asText();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Prompt — plain text output, no markdown tables or headers
    // ─────────────────────────────────────────────────────────────────────────

    private String buildPrompt(String companyName, String subject, String documentText) {
        return "You are a concise Indian equity market analyst. Analyze this NSE order announcement.\n\n"
            + "Company: " + companyName + "\n"
            + "Subject: " + subject + "\n"
            + "Document: " + trimText(documentText, 2000) + "\n\n"
            + "Reply with ONLY a JSON object (no markdown, no code blocks) with these exact fields:\n"
            + "{\n"
            + "  \"rating\": <number 1-10>,\n"
            + "  \"order_size_crores\": <number or null>,\n"
            + "  \"order_summary\": \"<one line: quantity/material ordered, customer name, order value (or 'value undisclosed')>\",\n"
            + "  \"final_verdict\": \"<3-5 plain text sentences: significance, red flags, clear action — Research/Watchlist/Ignore>\"\n"
            + "}\n\n"
            + "Rules:\n"
            + "- No markdown formatting (no **, ##, |, or bullet points)\n"
            + "- order_size_crores: extract from document text; null if not disclosed\n"
            + "- rating scale: 1-2=Ignore, 3-4=Low Impact, 5-6=Watchlist, 7-8=Good, 9-10=Strong\n"
            + "- Revenue impact weight is highest — order <1% of revenue caps rating at 5\n"
            + "- Be direct and specific, no vague language";
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Parse Gemini JSON response
    // ─────────────────────────────────────────────────────────────────────────

    private AnalysisResult parseResponse(String content, String companyName, String link, String documentText) {
        try {
            // Strip markdown code block if present
            String json = content.trim();
            if (json.startsWith("```")) {
                int start = json.indexOf('\n') + 1;
                int end   = json.lastIndexOf("```");
                if (end > start) json = json.substring(start, end).trim();
            }

            JsonNode node        = objectMapper.readTree(json);
            double rating        = node.path("rating").asDouble(5.0);
            String orderSummary  = node.path("order_summary").asText("");
            String finalVerdict  = node.path("final_verdict").asText("");
            Double orderSizeCr   = node.has("order_size_crores") && !node.get("order_size_crores").isNull()
                                   ? node.get("order_size_crores").asDouble() : null;

            String scannerLabel  = rating >= 9 ? "Research Immediately" : rating >= 5 ? "Watchlist" : "Ignore";
            String scannerEmoji  = rating >= 9 ? "🟢" : rating >= 5 ? "🟡" : "🔴";
            String quickVerdict  = rating >= 9 ? "Strong opportunity" : rating >= 7 ? "Good opportunity"
                                 : rating >= 5 ? "Watchlist" : rating >= 3 ? "Low impact" : "Ignore";

            String msg = companyName + "\n"
                       + "Rating: " + String.format("%.0f", rating) + "/10 — " + quickVerdict + "\n\n"
                       + (orderSummary.isBlank() ? "" : "Order: " + orderSummary + "\n\n")
                       + (finalVerdict.isBlank() ? "" : "Verdict: " + finalVerdict + "\n\n")
                       + "Source: " + link + "\n"
                       + scannerEmoji + " " + scannerLabel;

            return new AnalysisResult(rating, orderSizeCr, quickVerdict, orderSummary, scannerLabel, msg);

        } catch (Exception e) {
            logger.warn("[Gemini] JSON parse failed: {}", e.getMessage());
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fallback (no API key)
    // ─────────────────────────────────────────────────────────────────────────

    private AnalysisResult fallbackAnalysis(String companyName, String subject, String link, String documentText) {
        String combined      = (companyName + " " + subject + " " + documentText).toLowerCase(Locale.ROOT);
        Double orderSizeCr   = extractOrderSizeCrores(combined);

        double score = 3.0;
        if (combined.contains("order") || combined.contains("contract") || combined.contains("award")) score += 2.0;
        if (combined.contains("government") || combined.contains("railway") || combined.contains("defence")
                || combined.contains("solar") || combined.contains("export")) score += 2.0;
        if (orderSizeCr != null) {
            if      (orderSizeCr > 1000) score += 3.0;
            else if (orderSizeCr > 250)  score += 2.0;
            else if (orderSizeCr > 100)  score += 1.5;
            else if (orderSizeCr > 30)   score += 1.0;
            else if (orderSizeCr < 5)    score -= 1.0;
        }
        score = Math.max(0, Math.min(10, score));

        String scannerLabel = score >= 9 ? "Research Immediately" : score >= 5 ? "Watchlist" : "Ignore";
        String scannerEmoji = score >= 9 ? "🟢" : score >= 5 ? "🟡" : "🔴";
        String quickVerdict = score >= 9 ? "Strong opportunity" : score >= 7 ? "Good opportunity"
                            : score >= 5 ? "Watchlist" : "Low impact";
        String orderValue   = orderSizeCr != null ? String.format("INR %.2f Cr", orderSizeCr) : "Unknown";

        String msg = companyName + "\n"
                   + "Rating: " + String.format("%.0f", score) + "/10 — " + quickVerdict + "\n\n"
                   + "Order Value: " + orderValue + "\n"
                   + "Source: " + link + "\n"
                   + scannerEmoji + " " + scannerLabel;

        return new AnalysisResult(score, orderSizeCr, quickVerdict, subject, scannerLabel, msg);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Board-meeting-outcome analysis (results/financials) — separate from the
    // order/contract rating above, which doesn't apply to this announcement
    // category. Positives/Concerns/Overall Assessment only, deliberately no
    // fundamentals (Screener.in) or technicals section — per explicit request,
    // this alert type stays scoped to what's actually in the announcement PDF.
    // ─────────────────────────────────────────────────────────────────────────

    /** message + rating (average of rating_low/rating_high, for threshold checks) -- null message means analysis unavailable. */
    public record BoardMeetingAnalysis(String message, Double rating) {}

    public BoardMeetingAnalysis analyzeBoardMeetingPdf(String companyName, String subject, String documentText) {
        if (googleApiKey == null || googleApiKey.isBlank()) return new BoardMeetingAnalysis(null, null);
        try {
            String prompt = buildBoardMeetingPrompt(companyName, subject, documentText);
            String content = callGemini(prompt, 700);
            return formatBoardMeetingResult(content);
        } catch (Exception e) {
            logger.warn("[BoardMeeting] Analysis failed: {}", e.getMessage());
            return new BoardMeetingAnalysis(null, null);
        }
    }

    /**
     * Short, numbers-only verdict for the Quarterly Results dashboard card --
     * deliberately does NOT read the filed PDF. PdfExtractor truncates every
     * document to its first 4000 chars, which for a large filing (confirmed
     * live on WAAREEENER's real 4.04MB Jun 2026 results, 2026-07-30) is
     * usually just the cover letter/auditor header, not the actual results
     * commentary -- the AI's own honest verdict on that truncated text was
     * "substantive financial data unavailable", not a useful judgment. Feeds
     * the AI ONLY the already-reliable Screener.in-sourced YoY/QoQ figures
     * instead, so the verdict is grounded in real numbers every time.
     * Returns null if GOOGLE_API_KEY isn't set or the call fails --
     * callers must treat this as optional, same as the board-meeting analysis.
     */
    public String judgeQuarterlyTrend(String companyName, String quarterLabel,
                                       Double revenueCr, Double revenueYoyPct, Double revenueQoqPct,
                                       Double netProfitCr, Double netProfitYoyPct, Double netProfitQoqPct,
                                       String profitYoySwingType, String profitQoqSwingType,
                                       Double operatingMarginPct, Double marginYoyPp, Double marginQoqPp,
                                       Double eps, Double epsYoyPct, Double epsQoqPct,
                                       Double ebitdaCr, Double ebitdaYoyPct, Double ebitdaQoqPct,
                                       String ebitdaYoySwingType, String ebitdaQoqSwingType) {
        if (googleApiKey == null || googleApiKey.isBlank()) return null;
        try {
            String prompt = buildQuarterlyTrendPrompt(companyName, quarterLabel, revenueCr, revenueYoyPct, revenueQoqPct,
                    netProfitCr, netProfitYoyPct, netProfitQoqPct, profitYoySwingType, profitQoqSwingType,
                    operatingMarginPct, marginYoyPp, marginQoqPp, eps, epsYoyPct, epsQoqPct,
                    ebitdaCr, ebitdaYoyPct, ebitdaQoqPct, ebitdaYoySwingType, ebitdaQoqSwingType);

            String content = callGemini(prompt, 60);
            String verdict = content.trim();
            if (verdict.startsWith("\"") && verdict.endsWith("\"") && verdict.length() > 1) {
                verdict = verdict.substring(1, verdict.length() - 1).trim();
            }
            return verdict.isBlank() ? null : verdict;
        } catch (Exception e) {
            logger.warn("[QuarterlyTrend] judgment failed for {} {}: {}", companyName, quarterLabel, e.getMessage());
            return null;
        }
    }

    private String buildQuarterlyTrendPrompt(String companyName, String quarterLabel,
                                              Double revenueCr, Double revenueYoyPct, Double revenueQoqPct,
                                              Double netProfitCr, Double netProfitYoyPct, Double netProfitQoqPct,
                                              String profitYoySwingType, String profitQoqSwingType,
                                              Double operatingMarginPct, Double marginYoyPp, Double marginQoqPp,
                                              Double eps, Double epsYoyPct, Double epsQoqPct,
                                              Double ebitdaCr, Double ebitdaYoyPct, Double ebitdaQoqPct,
                                              String ebitdaYoySwingType, String ebitdaQoqSwingType) {
        StringBuilder sb = new StringBuilder();
        sb.append("Company: ").append(companyName).append("\n");
        sb.append("Quarter: ").append(quarterLabel).append("\n");
        sb.append("Revenue: Rs ").append(fmtCr(revenueCr)).append(" Cr (YoY ").append(fmtPct(revenueYoyPct))
                .append(", QoQ ").append(fmtPct(revenueQoqPct)).append(")\n");
        sb.append("Net Profit: Rs ").append(fmtCr(netProfitCr)).append(" Cr (YoY ")
                .append(profitYoySwingType != null ? swingText(profitYoySwingType) : fmtPct(netProfitYoyPct))
                .append(", QoQ ").append(profitQoqSwingType != null ? swingText(profitQoqSwingType) : fmtPct(netProfitQoqPct))
                .append(")\n");
        sb.append("Operating Margin: ").append(operatingMarginPct == null ? "n/a" : String.format("%.1f%%", operatingMarginPct))
                .append(" (YoY ").append(fmtPp(marginYoyPp)).append(", QoQ ").append(fmtPp(marginQoqPp)).append(")\n");
        sb.append("EPS: Rs ").append(eps == null ? "n/a" : String.format("%.2f", eps))
                .append(" (YoY ").append(fmtPct(epsYoyPct)).append(", QoQ ").append(fmtPct(epsQoqPct)).append(")\n");
        sb.append("EBITDA: Rs ").append(fmtCr(ebitdaCr)).append(" Cr (YoY ")
                .append(ebitdaYoySwingType != null ? swingText(ebitdaYoySwingType) : fmtPct(ebitdaYoyPct))
                .append(", QoQ ").append(ebitdaQoqSwingType != null ? swingText(ebitdaQoqSwingType) : fmtPct(ebitdaQoqPct))
                .append(")\n\n");
        sb.append("Give a single, short, one-line qualitative verdict (max ~14 words) on this quarter's ")
                .append("performance, based ONLY on these figures. Call out any tension between them if one ")
                .append("exists (e.g. YoY revenue growth but a sequential decline, or profit growth alongside ")
                .append("margin compression). Reply with ONLY the one-line verdict -- no quotes, no markdown, no extra text.");
        return sb.toString();
    }

    private String fmtCr(Double v) {
        return v == null ? "n/a" : String.format("%.0f", v);
    }

    private String fmtPct(Double v) {
        return v == null ? "n/a" : String.format("%+.1f%%", v);
    }

    /** Percentage-POINT formatting (margin comparisons) -- distinct from fmtPct's relative-% since margin is already a percentage. */
    private String fmtPp(Double v) {
        return v == null ? "n/a" : String.format("%+.1fpp", v);
    }

    private String swingText(String swingType) {
        return "LOSS_TO_PROFIT".equals(swingType) ? "swung from a loss to a profit" : "swung from a profit to a loss";
    }

    private String buildBoardMeetingPrompt(String companyName, String subject, String documentText) {
        return "You are analyzing an NSE \"Outcome of Board Meeting\" filing (typically quarterly/annual "
            + "financial results) for an Indian listed company.\n\n"
            + "Company: " + companyName + "\n"
            + "Subject: " + subject + "\n"
            + "Document: " + trimText(documentText, 4000) + "\n\n"
            + "Reply with ONLY a JSON object (no markdown, no code blocks) with these exact fields:\n"
            + "{\n"
            + "  \"positives\": [\"<short factual positive point>\", ...],\n"
            + "  \"concerns\": [\"<short factual concern/negative point>\", ...],\n"
            + "  \"overall_label\": \"<short qualitative phrase, e.g. 'Positive with some margin pressure'>\",\n"
            + "  \"rating_low\": <number 1-10>,\n"
            + "  \"rating_high\": <number 1-10, >= rating_low>\n"
            + "}\n\n"
            + "Rules:\n"
            + "- positives: 3-6 points, each one short plain sentence, based only on what's actually in the document\n"
            + "- concerns: 2-5 points, same style — if there are genuinely none, return an empty array, don't invent one\n"
            + "- Base everything strictly on the document text — revenue, profit, margins, costs, cash flow, "
            + "  balance sheet items, auditor remarks, guidance, anything explicitly stated\n"
            + "- Do not comment on the stock's valuation, technicals, or make a buy/sell recommendation — "
            + "  positives/concerns about the RESULTS THEMSELVES only\n"
            + "- No markdown formatting inside the point strings (no **, ##, bullets)";
    }

    private BoardMeetingAnalysis formatBoardMeetingResult(String content) {
        try {
            String json = content.trim();
            if (json.startsWith("```")) {
                int start = json.indexOf('\n') + 1;
                int end   = json.lastIndexOf("```");
                if (end > start) json = json.substring(start, end).trim();
            }
            JsonNode node = objectMapper.readTree(json);

            StringBuilder sb = new StringBuilder();
            JsonNode positives = node.path("positives");
            if (positives.isArray() && positives.size() > 0) {
                sb.append("*Positives*\n");
                for (JsonNode p : positives) sb.append("✅ ").append(p.asText()).append("\n");
                sb.append("\n");
            }

            JsonNode concerns = node.path("concerns");
            if (concerns.isArray() && concerns.size() > 0) {
                sb.append("*Concerns*\n");
                for (JsonNode c : concerns) sb.append("⚠️ ").append(c.asText()).append("\n");
                sb.append("\n");
            }

            Double rating = null;
            String label = node.path("overall_label").asText("");
            if (!label.isBlank()) {
                double lo = node.path("rating_low").asDouble(0);
                double hi = node.path("rating_high").asDouble(lo);
                rating = (lo + hi) / 2.0;
                String range = lo == hi ? trimTrailingZero(lo) : trimTrailingZero(lo) + "–" + trimTrailingZero(hi);
                sb.append("*Overall Assessment*\n");
                sb.append("*Rating:* ").append(label).append(" (").append(range).append("/10)");
            }

            String result = sb.toString().stripTrailing();
            return new BoardMeetingAnalysis(result.isBlank() ? null : result, rating);
        } catch (Exception e) {
            logger.warn("[BoardMeeting] JSON parse failed: {}", e.getMessage());
            return new BoardMeetingAnalysis(null, null);
        }
    }

    private String trimTrailingZero(double v) {
        return v == Math.floor(v) ? String.valueOf((int) v) : String.valueOf(v);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Order size extraction — handles Indian rupee format (Rs. 27,06,04,323/-)
    // ─────────────────────────────────────────────────────────────────────────

    private Double extractOrderSizeCrores(String text) {
        if (text == null || text.isBlank()) return null;

        // Indian rupee raw amount: Rs. 27,06,04,323/- → 27.06 Cr
        Pattern inrRaw = Pattern.compile(
            "(?:rs\\.?|₹|inr)\\s*([0-9]{1,2}(?:,[0-9]{2})*,[0-9]{3})\\s*(?:/-|/)?",
            Pattern.CASE_INSENSITIVE);
        Matcher m = inrRaw.matcher(text);
        if (m.find()) {
            try {
                double rupees = Double.parseDouble(m.group(1).replaceAll(",", ""));
                if (rupees > 100_000) return rupees / 1_00_00_000.0;
            } catch (NumberFormatException ignored) {}
        }

        Double v;
        v = extractFromPattern(text, "([0-9]+(?:\\.[0-9]+)?)\\s*(?:crore|cr|crores)");
        if (v != null) return v;
        v = extractFromPattern(text, "([0-9]+(?:\\.[0-9]+)?)\\s*(?:million|mn)");
        if (v != null) return v * 0.1;
        v = extractFromPattern(text, "([0-9]+(?:\\.[0-9]+)?)\\s*(?:billion|bn)");
        if (v != null) return v * 100;
        return null;
    }

    private Double extractFromPattern(String text, String regex) {
        Matcher m = Pattern.compile(regex, Pattern.CASE_INSENSITIVE).matcher(text);
        if (m.find()) {
            try { return Double.parseDouble(m.group(1).replaceAll(",", "")); }
            catch (NumberFormatException ignored) {}
        }
        return null;
    }

    private String trimText(String text, int max) {
        if (text == null || text.length() <= max) return text;
        return text.substring(0, max) + "...";
    }
}
