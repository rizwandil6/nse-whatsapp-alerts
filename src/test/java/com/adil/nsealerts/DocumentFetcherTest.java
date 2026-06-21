package com.adil.nsealerts;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.RestTemplate;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class DocumentFetcherTest {

    @Test
    void fetchTextReturnsEmptyForBlankUrl() {
        DocumentFetcher fetcher = new DocumentFetcher();

        assertEquals("", fetcher.fetchText(" ")); 
        assertEquals("", fetcher.fetchText(null));
    }

    @Test
    void fetchTextReturnsPdfTextWhenPdfUrl() throws Exception {
        DocumentFetcher fetcher = new DocumentFetcher();
        RestTemplate mockRestTemplate = mock(RestTemplate.class);
        ReflectionTestUtils.setField(fetcher, "restTemplate", mockRestTemplate);

        byte[] pdfBytes = generateMinimalPdf("Hello PDF");
        when(mockRestTemplate.exchange(any(), eq(HttpMethod.GET), any(), eq(byte[].class)))
                .thenReturn(ResponseEntity.ok(pdfBytes));

        String text = fetcher.fetchText("https://example.com/report.pdf");
        assertTrue(text.contains("Hello"), "Expected extracted PDF text to contain 'Hello'");
    }

    @Test
    void findPdfLinkExtractsPdfUrlFromHtml() throws Exception {
        DocumentFetcher fetcher = new DocumentFetcher();
        Method findPdfLink = DocumentFetcher.class.getDeclaredMethod("findPdfLink", String.class, String.class);
        findPdfLink.setAccessible(true);

        String html = "<html><body><a href=\"/docs/report.pdf\">Download PDF</a></body></html>";
        Optional<String> pdfLink = (Optional<String>) findPdfLink.invoke(fetcher, html, "https://example.com/page");

        assertTrue(pdfLink.isPresent());
        assertEquals("https://example.com/docs/report.pdf", pdfLink.get());
    }

    @Test
    void extractTextFromHtmlRemovesScriptsStylesAndNavigation() throws Exception {
        DocumentFetcher fetcher = new DocumentFetcher();
        Method extractText = DocumentFetcher.class.getDeclaredMethod("extractTextFromHtml", String.class);
        extractText.setAccessible(true);

        String html = "<html><head><style>body {}</style></head><body>Visible text<script>var x=1;</script><nav>nav</nav></body></html>";
        String extracted = (String) extractText.invoke(fetcher, html);

        assertEquals("Visible text", extracted);
    }

    @Test
    void normalizeUrlAddsHttpsForProtocolRelativeLinks() throws Exception {
        DocumentFetcher fetcher = new DocumentFetcher();
        Method normalizeUrl = DocumentFetcher.class.getDeclaredMethod("normalizeUrl", String.class);
        normalizeUrl.setAccessible(true);

        String normalized = (String) normalizeUrl.invoke(fetcher, "//example.com/page");
        assertEquals("https://example.com/page", normalized);
    }

    private byte[] generateMinimalPdf(String text) throws Exception {
        try (PDDocument document = new PDDocument(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            PDPage page = new PDPage();
            document.addPage(page);
            try (PDPageContentStream content = new PDPageContentStream(document, page)) {
                content.beginText();
                content.setFont(PDType1Font.HELVETICA_BOLD, 12);
                content.newLineAtOffset(50, 700);
                content.showText(text);
                content.endText();
            }
            document.save(output);
            return output.toByteArray();
        }
    }
}
