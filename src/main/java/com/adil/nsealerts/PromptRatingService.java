package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
    private static final String OPENAI_URL = "https://api.openai.com/v1/chat/completions";
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${analysis.openai-api-key:}")
    private String openAiApiKey;

    public AnalysisResult analyze(String title, String description, String link, String documentText) {
        String prompt = buildPrompt(title, description, link, documentText);
        if (openAiApiKey != null && !openAiApiKey.isBlank()) {
            try {
                return analyzeWithOpenAi(prompt);
            } catch (Exception e) {
                System.err.println("OpenAI analysis failed: " + e.getMessage());
            }
        }
        return fallbackAnalysis(title, description, documentText);
    }

    private String buildPrompt(String title, String description, String link, String documentText) {
        StringBuilder builder = new StringBuilder();
        builder.append("Analyze the following NSE/BSE corporate filing as an investor interested in material business announcements. ");
        builder.append("Start with a one-line company snapshot. Rate the impact 0-10. Extract order size in crores if present. ");
        builder.append("Classify the announcement as High Priority, Medium Priority, or Ignore. ");
        builder.append("Return valid JSON with fields: rating, order_size_crores, impact_level, summary. ");
        builder.append("Use the following guidance: 0-2 Ignore, 3-4 Low Impact, 5-6 Watchlist, 7-8 Good, 9 Strong, 10 Exceptional. ");
        builder.append("Weight order impact relative to revenue most heavily. Use positive weight for government, defence, railway, renewable, export, O&M, recurring revenue, long-term visibility, new geographies. Deduct for undisclosed order value, long execution period, renewals, or small orders. ");
        builder.append("If order size cannot be extracted, set order_size_crores to null. ");
        builder.append("Input fields:\n");
        builder.append("Title: ").append(title).append("\n");
        builder.append("Description: ").append(description).append("\n");
        builder.append("Link: ").append(link).append("\n");
        if (documentText != null && !documentText.isBlank()) {
            builder.append("DocumentText: ").append(trimText(documentText, 3000)).append("\n");
        }
        return builder.toString();
    }

    private AnalysisResult analyzeWithOpenAi(String prompt) throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        var rootNode = objectMapper.createObjectNode();
        var messages = objectMapper.createArrayNode();
        var message = objectMapper.createObjectNode();
        message.put("role", "user");
        message.put("content", prompt);
        messages.add(message);
        rootNode.put("model", "gpt-3.5-turbo");
        rootNode.set("messages", messages);
        rootNode.put("max_tokens", 400);
        rootNode.put("temperature", 0.2);
        String requestBody = rootNode.toString();

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(OPENAI_URL))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + openAiApiKey)
                .POST(HttpRequest.BodyPublishers.ofString(requestBody, StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() != 200) {
            throw new RuntimeException("OpenAI API call failed: " + response.statusCode() + " " + response.body());
        }

        JsonNode root = objectMapper.readTree(response.body());
        JsonNode messageNode = root.at("/choices/0/message/content");
        if (messageNode.isMissingNode()) {
            throw new RuntimeException("OpenAI response missing message content");
        }
        String content = messageNode.asText();
        return parseOpenAiJson(content);
    }

    private AnalysisResult parseOpenAiJson(String content) {
        try {
            JsonNode resultNode = objectMapper.readTree(content);
            double rating = resultNode.path("rating").asDouble(0.0);
            Double orderSize = resultNode.has("order_size_crores") && !resultNode.get("order_size_crores").isNull()
                    ? resultNode.get("order_size_crores").asDouble() : null;
            String quickVerdict = resultNode.path("quick_verdict").asText("");
            String impact = resultNode.path("impact_level").asText("");
            String summary = resultNode.path("summary").asText("");
            return new AnalysisResult(rating, orderSize, quickVerdict, summary, impact);
        } catch (Exception e) {
            System.err.println("Failed to parse OpenAI analysis JSON, falling back: " + e.getMessage());
            return fallbackAnalysis("", content, content);
        }
    }

    private AnalysisResult fallbackAnalysis(String title, String description, String documentText) {
        String combined = (title + " " + description + " " + documentText).toLowerCase(Locale.ROOT);
        Double orderSizeCrores = extractOrderSizeCrores(combined);
        double score = 3.0;
        if (combined.contains("order") || combined.contains("contract") || combined.contains("award")) {
            score += 2.0;
        }
        if (combined.contains("government") || combined.contains("govt") || combined.contains("defence") || combined.contains("railway") || combined.contains("export") || combined.contains("renewable") || combined.contains("solar") || combined.contains("power")) {
            score += 2.0;
        }
        if (orderSizeCrores != null) {
            if (orderSizeCrores > 1000) score += 3.0;
            else if (orderSizeCrores > 250) score += 2.0;
            else if (orderSizeCrores > 100) score += 1.5;
            else if (orderSizeCrores > 30) score += 1.0;
            else if (orderSizeCrores < 5) score -= 1.0;
        }
        if (combined.contains("renewal") || combined.contains("renewed") || combined.contains("repeat order")) {
            score -= 1.0;
        }
        score = Math.max(0.0, Math.min(10.0, score));
        String summary = "Heuristic analysis: " + (orderSizeCrores != null ? "order size ~" + orderSizeCrores + " Cr." : "order size unknown") + ".";
        String quickVerdict = score >= 9 ? "Strong opportunity" : score >= 7 ? "Good opportunity" : score >= 5 ? "Watchlist" : score >= 3 ? "Low impact" : "Ignore";
        String impact = orderSizeCrores == null ? "Ignore" : orderSizeCrores > 100 ? "High Priority" : "Medium Priority";
        return new AnalysisResult(score, orderSizeCrores, quickVerdict, summary, impact);
    }

    private Double extractOrderSizeCrores(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        Double value = extractFromPattern(text, "(₹|inr)?\\s*([0-9]+(?:\\.[0-9]+)?)\\s*(crore|cr|crores)");
        if (value != null) {
            return value;
        }
        value = extractFromPattern(text, "(₹|inr)?\\s*([0-9]+(?:\\.[0-9]+)?)\\s*(million|mn)");
        if (value != null) {
            return value * 0.1;
        }
        value = extractFromPattern(text, "(₹|inr)?\\s*([0-9]+(?:\\.[0-9]+)?)\\s*(billion|bn)");
        if (value != null) {
            return value * 100;
        }
        value = extractFromPattern(text, "(₹|inr)?\\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]+)?)\\s*(crore|cr|crores)");
        return value;
    }

    private Double extractFromPattern(String text, String regex) {
        Pattern pattern = Pattern.compile(regex, Pattern.CASE_INSENSITIVE);
        Matcher matcher = pattern.matcher(text);
        if (matcher.find()) {
            String number = matcher.group(2).replaceAll(",", "");
            try {
                return Double.parseDouble(number);
            } catch (NumberFormatException ignored) {
            }
        }
        return null;
    }

    private String trimText(String text, int maxLength) {
        if (text == null || text.length() <= maxLength) {
            return text;
        }
        return text.substring(0, maxLength) + "...";
    }
}
