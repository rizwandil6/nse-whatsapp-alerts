package com.adil.nsealerts;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@Service
public class PdfExtractor {
    private static final Logger logger = LoggerFactory.getLogger(PdfExtractor.class);
    private static final int MAX_BYTES   = 5 * 1024 * 1024; // 5 MB size limit
    private static final int MAX_CHARS   = 4000;             // max chars to send to OpenAI
    private static final int CONNECT_MS  = 5_000;
    private static final int READ_MS     = 15_000;

    // Full-results-statement PDFs (used by ResultsPdfParser's stale-Screener fallback,
    // added 2026-07-31) need the WHOLE document, not the first 4000 chars -- the actual
    // P&L table sits deep in the filing (page 4 of 20 for GAIL's real Jun 2026 filing,
    // Standalone; page 12 for Consolidated), and these filings run bigger than the
    // 5MB/4000-char budget sized for the board-meeting AI summary use case (GAIL's was
    // 8.4MB). A separate, higher ceiling here -- this path is only hit as a rare
    // fallback, not on every announcement.
    private static final int MAX_BYTES_FULL = 20 * 1024 * 1024; // 20 MB

    /**
     * Downloads the PDF at {@code url} and returns its FULL extracted plain text (no
     * 4000-char truncation), or {@code null} if download/parsing fails. Use this
     * instead of {@link #extractText(String)} when the caller needs to locate content
     * that isn't guaranteed to be near the start of the document.
     */
    public String extractFullText(String url) {
        if (url == null || url.isBlank() || !url.toLowerCase().endsWith(".pdf")) {
            return null;
        }
        try {
            byte[] bytes = download(url);
            if (bytes == null || bytes.length == 0) return null;
            if (bytes.length > MAX_BYTES_FULL) {
                logger.warn("[PDF] Skipping oversized PDF ({} KB): {}", bytes.length / 1024, url);
                return null;
            }
            try (PDDocument doc = PDDocument.load(new ByteArrayInputStream(bytes))) {
                PDFTextStripper stripper = new PDFTextStripper();
                String text = stripper.getText(doc).trim();
                logger.info("[PDF] Extracted {} chars (full) from {}", text.length(), url);
                return text;
            }
        } catch (Exception e) {
            logger.warn("[PDF] Failed to extract full text from {}: {}", url, e.getMessage());
            return null;
        }
    }

    /**
     * Downloads the PDF at {@code url} and returns its extracted plain text,
     * or {@code null} if download/parsing fails.
     */
    public String extractText(String url) {
        if (url == null || url.isBlank() || !url.toLowerCase().endsWith(".pdf")) {
            return null;
        }
        try {
            byte[] bytes = download(url);
            if (bytes == null || bytes.length == 0) return null;
            if (bytes.length > MAX_BYTES) {
                logger.warn("[PDF] Skipping oversized PDF ({} KB): {}", bytes.length / 1024, url);
                return null;
            }

            try (PDDocument doc = PDDocument.load(new ByteArrayInputStream(bytes))) {
                PDFTextStripper stripper = new PDFTextStripper();
                String text = stripper.getText(doc).trim();
                if (text.length() > MAX_CHARS) {
                    text = text.substring(0, MAX_CHARS);
                }
                logger.info("[PDF] Extracted {} chars from {}", text.length(), url);
                return text;
            }
        } catch (Exception e) {
            logger.warn("[PDF] Failed to extract text from {}: {}", url, e.getMessage());
            return null;
        }
    }

    private byte[] download(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestProperty("User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
        conn.setRequestProperty("Referer", "https://www.nseindia.com");
        conn.setRequestProperty("Accept", "application/pdf,*/*");
        conn.setConnectTimeout(CONNECT_MS);
        conn.setReadTimeout(READ_MS);
        conn.connect();

        int code = conn.getResponseCode();
        if (code != 200) {
            logger.warn("[PDF] HTTP {} downloading {}", code, url);
            return null;
        }
        return conn.getInputStream().readAllBytes();
    }
}
