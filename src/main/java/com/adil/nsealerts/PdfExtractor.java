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
