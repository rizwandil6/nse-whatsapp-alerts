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
                logger.error("OpenAI analysis failed", e);
            }
        }
        return fallbackAnalysis(title, description, link, documentText);
    }

    private String buildPrompt(String title, String description, String link, String documentText) {
        StringBuilder builder = new StringBuilder();
        builder.append("""
Analyze the attached NSE/BSE filing strictly from the perspective of an investor looking for announcements that can materially impact future revenue, earnings, order book strength, and stock performance. Start with a **Company Snapshot** in exactly one line describing what the company does. Then provide a **Quick Verdict** with a rating out of 10 using the following scale: 0-2 = Ignore, 3-4 = Low Impact, 5-6 = Watchlist, 7-8 = Good, 9 = Strong, 10 = Exceptional.

First classify the filing as one of the following categories:

**🟢 High Priority:** Awarding of Orders/Contracts, Letter of Award (LOA), Work Orders, Government Contracts, Defence Orders, Railway Contracts, Solar EPC Orders, Export Orders, Capacity Expansions, Major Acquisitions.

**🟡 Medium Priority:** SPV Formation, Joint Ventures, Strategic Partnerships, Long-Term Service Agreements, Fund Raising.

**🔴 Ignore:** GST Notices, Tax Demands, Arbitration Awards, Litigation, Court Orders, Regulatory Penalties, Compliance Disclosures, Clarifications, Investor Presentations, OFS, Promoter Stake Sales, Equipment Purchases, Internal Corporate Actions.

Then extract and display:

- Customer Name
- Order Value
- Project Name
- Sector
- Domestic or International
- Execution Timeline
- O&M / AMC Duration (if applicable)

---

### **Order Value Classification (Mandatory)**

Before scoring, classify the filing into one of these four categories:

**Category A - Exact Order Value Disclosed**

Examples:

- INR89.95 Lakh
- INR45.64 Cr
- INR300 Cr
- INR2,977 Cr

Action:

- Treat order value as KNOWN.
- Calculate revenue impact.
- Apply normal scoring.

Examples:

- Innomet
- RVNL
- HFCL
- MAN Industries

---

**Category B - Aggregate Value Disclosed**

Examples:

- "Orders worth INR608 Cr received since last disclosure"
- Multiple orders bundled into one announcement

Action:

- Treat order value as KNOWN.
- Revenue impact can be estimated.
- Penalize 1-2 points for lack of order-level detail.

Examples:

- BEL order update

Maximum rating normally should not exceed 8/10.

---

**Category C - Threshold / Minimum Value Disclosed**

Examples:

- Mega Order
- Above USD 150 Million
- Order exceeds INR500 Cr

Action:

- Use minimum disclosed value.
- Mention actual value unknown.
- Penalize only slightly.

Examples:

- WABAG Kuwait order

---

**Category D - Order Value Unknown**

Examples:

- Strategic partnership announced
- Contract announced
- No value disclosed anywhere

Action:

- Revenue impact cannot be calculated.
- Cap overall rating at 5/10.

Examples:

- Contracts without disclosed value
- Partnerships without commercial terms

---

### **Important Rule**

Order Value and Revenue Impact are separate concepts.

If the filing discloses:

- INR89.95 Lakh
- INR1.02 Cr
- INR608 Cr
- INR2,977 Cr

then **Order Value Status = Known** even if the order is tiny.

Never classify a disclosed order as "Order Value Unknown" simply because the impact is small.

Examples:

✅ Correct:

Order Value = INR89.95 Lakh (Known)

Revenue Impact = Very Small

❌ Incorrect:

Order Value = Unknown

---

### **Revenue Check (Mandatory)**

Fetch latest annual revenue (FY25 or latest available).

Display:

Revenue: INRX Cr

Order Value: INRY Cr

Order Impact:

Order Value ÷ Annual Revenue × 100

---

### **Revenue Impact Rating**

Use this framework:

**Order as % of Revenue**

**Interpretation**

<1%

Ignore

1-5%

Watch

5-10%

Good

10-20%

Strong

20-30%

Very Strong

>30%

Exceptional

This metric should carry the highest weight in scoring.

Revenue impact is more important than absolute order size.

---

### **Positive Factors**

Add weight if applicable:

✅ Government customer

✅ Defence customer

✅ Ministry order

✅ Railway order

✅ Renewable energy / Solar

✅ Export order

✅ International expansion

✅ O&M / AMC revenue

✅ Recurring revenue

✅ Multi-year visibility

✅ Entry into new geography

✅ Large order book disclosed

✅ Fast execution (<12 months)

✅ Strategic technology

---

### **Negative Factors**

Deduct points if:

❌ Customer undisclosed

❌ Order value undisclosed

❌ Execution timeline undisclosed

❌ Only aggregate value disclosed

❌ Commodity business with weak margins

❌ Renewal contract only

❌ Order less than 1% of revenue

❌ Pure compliance announcement

❌ Equipment purchase instead of order win

❌ Internal restructuring

---

### **Scorecard**

Provide:

**Factor**

**Score**

Order Size

X/10

Revenue Impact

X/10

Customer Quality

X/10

Strategic Importance

X/10

Revenue Visibility

X/10

Then calculate:

**Overall Rating: X/10**

---

### **Scanner Decision**

Choose exactly one:

🟢 Research Immediately

🟡 Watchlist

🔴 Ignore

---

### **Benchmark Comparison (Mandatory)**

Compare against previously analyzed filings:

**Company**

**Benchmark Score**

HFCL BharatNet (~55% revenue impact)

10/10

WABAG Kuwait Mega Project (~37%+ revenue impact)

10/10

RVNL NMDC INR2,977 Cr (~14% revenue impact)

9.5/10

MAN Industries INR1,000 Cr (~29% revenue impact)

9.5/10

Krishna Defence (~23% revenue impact)

9/10

Arfin India INR300 Cr (~38% revenue impact)

9/10

RVNL INR968 Cr (~4.5% revenue impact)

8.5/10

BEL INR608 Cr Aggregate Order Update

5/10 (Watchlist - aggregate order details unavailable)

Innomet INR89.95 Lakh

4/10 (Watchlist - exact value known but too small)

Use these as anchors when assigning scores.

---

### **Output Format**

## **Company Snapshot**

👉 One-line business description.

## **Quick Verdict**

Rating X/10

## **Filing Type**

Category

## **Order Value Status**

✅ Known

🟡 Aggregate

🟡 Threshold-Based

❌ Unknown

## **Order Details**

## **Revenue Check**

Revenue:

Order Value:

Order Impact:

## **Positive Factors**

## **Red Flags**

## **Scorecard**

## **Scanner Decision**

## **Final Verdict**

Keep the analysis concise, investor-focused, and optimized for quickly filtering NSE/BSE announcements into actionable opportunities. The final verdict must clearly state whether the announcement is likely to materially affect future earnings and why.

Return valid JSON with fields: rating, order_size_crores, quick_verdict, impact_level, summary, whatsapp_message.
Set order_size_crores to null if unavailable.
Set whatsapp_message to the final WhatsApp-ready markdown text, using this exact heading order:
## **Company Snapshot**
## **Quick Verdict**
## **Order Details**
## **Revenue Check**
## **Red Flags**
## **Scorecard**
### ### **Overall Rating**
## **Scanner Decision**
### **Final Verdict**

Input fields:
""");
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
        rootNode.put("model", "gpt-4o-mini");
        rootNode.set("messages", messages);
        rootNode.put("max_tokens", 2000);
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
            String whatsappMessage = resultNode.path("whatsapp_message").asText("");
            return new AnalysisResult(rating, orderSize, quickVerdict, summary, impact, whatsappMessage);
        } catch (Exception e) {
            logger.error("Failed to parse OpenAI analysis JSON, falling back", e);
            return fallbackAnalysis("", content, "", content);
        }
    }

    private AnalysisResult fallbackAnalysis(String title, String description, String link, String documentText) {
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

        String scannerEmoji = score >= 9 ? "🟢" : score >= 5 ? "🟡" : "🔴";
        String scannerDecision = score >= 9 ? "Research Immediately" : score >= 5 ? "Watchlist" : "Ignore";
        String orderValue = orderSizeCrores != null
                ? String.format("INR %.2f Cr", orderSizeCrores)
                : "Unknown";
        String companyName = title != null && !title.isBlank() ? title : "Company";
        String source = link != null && !link.isBlank() ? link : "N/A";

        String whatsappMessage = "Company Snapshot\n"
                + "👉 " + companyName + "\n\n"
                + "Quick Verdict\n"
                + "Rating " + String.format("%.1f", score) + "/10 - " + quickVerdict + "\n\n"
                + "Order Details\n"
                + "Order Value: " + orderValue + "\n"
                + "Source: " + source + "\n\n"
                + "Overall Rating\n"
                + String.format("%.1f", score) + "/10\n\n"
                + "Scanner Decision\n"
                + scannerEmoji + " " + scannerDecision;

        return new AnalysisResult(score, orderSizeCrores, quickVerdict, summary, impact, whatsappMessage);
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
