package com.adil.nsealerts;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.util.Optional;
import java.util.regex.Pattern;

@Component
public class DocumentFetcher {
    private static final Logger logger = LoggerFactory.getLogger(DocumentFetcher.class);
    private final RestTemplate restTemplate;
    private static final Pattern PDF_LINK_PATTERN = Pattern.compile("(?i).*\\.pdf($|\\?.*)");

    public DocumentFetcher() {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(10000);
        requestFactory.setReadTimeout(15000);
        this.restTemplate = new RestTemplate(requestFactory);
    }

    public String fetchText(String url) {
        try {
            if (url == null || url.isBlank()) {
                return "";
            }
            String normalized = normalizeUrl(url);
            if (isPdfLink(normalized)) {
                return fetchPdfText(normalized);
            }

            String html = fetchHtml(normalized);
            Optional<String> pdfLink = findPdfLink(html, normalized);
            if (pdfLink.isPresent()) {
                return fetchPdfText(pdfLink.get());
            }
            return extractTextFromHtml(html);
        } catch (Exception e) {
            logger.error("DocumentFetcher failed for {}", url, e);
            return "";
        }
    }

    private String normalizeUrl(String url) {
        if (url.startsWith("//")) {
            return "https:" + url;
        }
        return url;
    }

    private boolean isPdfLink(String url) {
        return PDF_LINK_PATTERN.matcher(url).matches() || url.toLowerCase().contains("application/pdf");
    }

    private String fetchPdfText(String pdfUrl) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
            HttpEntity<String> requestEntity = new HttpEntity<>(headers);
            ResponseEntity<byte[]> response = restTemplate.exchange(URI.create(pdfUrl), HttpMethod.GET, requestEntity, byte[].class);
            if (response.getStatusCode() == HttpStatus.OK && response.getBody() != null) {
                try (PDDocument document = PDDocument.load(new ByteArrayInputStream(response.getBody()))) {
                    PDFTextStripper stripper = new PDFTextStripper();
                    String text = stripper.getText(document);
                    return text == null ? "" : text;
                }
            }
        } catch (Exception e) {
            logger.warn("Failed to download PDF from {}", pdfUrl, e);
        }
        return "";
    }

    private String fetchHtml(String url) {
        try {
            return Jsoup.connect(url)
                    .userAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                    .timeout(15000)
                    .followRedirects(true)
                    .get()
                    .html();
        } catch (Exception e) {
            logger.warn("Failed to fetch HTML from {}", url, e);
            return "";
        }
    }

    private Optional<String> findPdfLink(String html, String baseUrl) {
        try {
            if (html == null || html.isBlank()) {
                return Optional.empty();
            }
            Document document = Jsoup.parse(html, baseUrl);
            Elements links = document.select("a[href]");
            for (Element link : links) {
                String href = link.absUrl("href");
                if (href.isBlank()) {
                    href = link.attr("href");
                }
                if (href != null && isPdfLink(href)) {
                    return Optional.of(href);
                }
            }
        } catch (Exception e) {
            logger.warn("Failed to parse HTML for PDF links", e);
        }
        return Optional.empty();
    }

    private String extractTextFromHtml(String html) {
        try {
            Document document = Jsoup.parse(html);
            document.select("script, style, noscript, header, footer, nav, form").remove();
            String text = document.body() != null ? document.body().text() : document.text();
            if (text == null) {
                return "";
            }
            return text;
        } catch (Exception e) {
            logger.warn("Failed to extract text from HTML", e);
            return "";
        }
    }
}
