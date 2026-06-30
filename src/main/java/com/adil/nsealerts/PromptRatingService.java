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

    @Value("${anthropic.api-key:}")
    private String anthropicApiKey;

    public AnalysisResult analyze(String companyName, String subject, String link, String documentText) {
        if (anthropicApiKey != null && !anthropicApiKey.isBlank()) {
            try {
                return analyzeWithAnthropic(companyName, subject, link, documentText);
            } catch (Exception e) {
                logger.error("Anthropic analysis failed: {}", e.getMessage());
            }
        }
        return fallbackAnalysis(companyName, subject, link, documentText);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Anthropic (Claude Haiku)
    // ─────────────────────────────────────────────────────────────────────────

    private AnalysisResult analyzeWithAnthropic(String companyName, String subject,
                                                 String link, String documentText) throws Exception {
        String prompt = buildPrompt(companyName, subject, documentText);

        var rootNode = objectMapper.createObjectNode();
        var messages = objectMapper.createArrayNode();
        var message  = objectMapper.createObjectNode();
        message.put("role", "user");
        message.put("content", prompt);
        messages.add(message);
        rootNode.put("model", "claude-haiku-4-5-20251001");
        rootNode.put("max_tokens", 600);
        rootNode.set("messages", messages);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("https://api.anthropic.com/v1/messages"))
                .header("Content-Type", "application/json")
                .header("x-api-key", anthropicApiKey)
                .header("anthropic-version", "2023-06-01")
                .POST(HttpRequest.BodyPublishers.ofString(rootNode.toString(), StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> response = HttpClient.newHttpClient()
                .send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

        if (response.statusCode() != 200) {
            throw new RuntimeException("Anthropic API error: " + response.statusCode() + " " + response.body());
        }

        String content = objectMapper.readTree(response.body()).at("/content/0/text").asText();
        logger.debug("[Anthropic] Response: {}", content);
        return parseResponse(content, companyName, link, documentText);
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
    // Parse Anthropic JSON response
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
            logger.warn("[Anthropic] JSON parse failed: {}", e.getMessage());
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
