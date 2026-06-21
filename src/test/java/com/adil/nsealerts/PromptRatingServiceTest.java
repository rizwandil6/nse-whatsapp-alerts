package com.adil.nsealerts;

import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.lang.reflect.Method;

import static org.junit.jupiter.api.Assertions.*;

class PromptRatingServiceTest {

    @Test
    void analyzeUsesFallbackWhenOpenAiKeyIsMissing() {
        PromptRatingService service = new PromptRatingService();
        ReflectionTestUtils.setField(service, "openAiApiKey", "");

        AnalysisResult result = service.analyze(
                "Government contract win",
                "The company secured an order for renewable power equipment worth ₹550 crore.",
                "https://example.com/announcement",
                "The contract is for a government renewable energy project."
        );

        assertNotNull(result);
        assertTrue(result.getRating() >= 7.0, "Expected fallback analysis score to be at least 7.0");
        assertEquals(550.0, result.getOrderSizeCrores());
        assertEquals("High Priority", result.getImpactLevel());
        assertTrue(result.getQuickVerdict().contains("opportunity") || result.getQuickVerdict().contains("Watchlist"));
    }

    @Test
    void extractOrderSizeCroresRecognizesMultipleCurrencyFormats() throws Exception {
        PromptRatingService service = new PromptRatingService();
        Method extractOrderSizeCrores = PromptRatingService.class.getDeclaredMethod("extractOrderSizeCrores", String.class);
        extractOrderSizeCrores.setAccessible(true);

        assertEquals(550.0, extractOrderSizeCrores.invoke(service, "Order size ₹550 crore"));
        assertEquals(16.0, extractOrderSizeCrores.invoke(service, "Order size 160 million"));
        assertEquals(250.0, extractOrderSizeCrores.invoke(service, "Order size 2.5 billion"));
    }

    @Test
    void buildPromptIncludesTitleDescriptionLinkAndTrimmedDocumentText() throws Exception {
        PromptRatingService service = new PromptRatingService();
        Method buildPrompt = PromptRatingService.class.getDeclaredMethod("buildPrompt", String.class, String.class, String.class, String.class);
        buildPrompt.setAccessible(true);

        String longDocument = "A".repeat(3100);
        String prompt = (String) buildPrompt.invoke(service, "Title", "Description", "https://example.com", longDocument);

        assertTrue(prompt.contains("Title: Title"));
        assertTrue(prompt.contains("Description: Description"));
        assertTrue(prompt.contains("Link: https://example.com"));
        assertTrue(prompt.contains("DocumentText:"));
        assertTrue(prompt.contains("...\n"), "Prompt should contain an ellipsis when document text is too long");
        assertTrue(prompt.indexOf("DocumentText:") < prompt.length() - 5, "DocumentText should appear before the ellipsis");
    }
}
