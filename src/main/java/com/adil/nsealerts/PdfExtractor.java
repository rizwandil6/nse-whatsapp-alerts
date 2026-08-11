package com.adil.nsealerts;

import net.sourceforge.tess4j.Tesseract;
import net.sourceforge.tess4j.TesseractException;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.graphics.PDXObject;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.awt.image.BufferedImage;
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

    // --- OCR fallback (added 2026-08-11) -------------------------------------------
    //
    // Real incident: of the ~135 "pdf_unparseable" quarterly_results_failures rows at
    // the time this was built, most were ordinary text-native filings failing on a
    // narrow header/wording regex in ResultsPdfParser (a different, endless whack-a-mole
    // problem -- not addressed here). But a genuine minority are truly scanned: VIKRAN's
    // real filing has its entire results-table pages (2-10 of 16) as ONE large JPEG per
    // page with ZERO embedded text -- PDFTextStripper has nothing to extract there no
    // matter how the regexes are tuned. This OCR fallback targets exactly that case: a
    // page with (near-)no extractable text that DOES contain image content is rendered
    // to a raster image and run through Tesseract, and its OCR'd text is spliced into
    // the page's slot in the full-text output. Pages that already have real text are
    // left untouched (OCR is slow -- no reason to pay for it where PDFBox already works).
    //
    // Requires the `tesseract-ocr` system package (native lib) to be present -- see the
    // repo-root Dockerfile. tess4j degrades to throwing at OCR-call time (not at class
    // load), so a deploy missing the native lib doesn't crash the app; ocrPage() catches
    // that and returns null, and the caller just keeps whatever PDFBox already had for
    // that page (empty string), identical to pre-OCR behavior -- this feature can only
    // help, never regress a deploy that lacks the native dependency.
    private static final int OCR_CANDIDATE_MAX_CHARS = 30;  // page text below this AND has an image -> OCR candidate
    private static final int OCR_MAX_PAGES_PER_DOC    = 15; // bound worst-case latency on a big scanned filing
    private static final float OCR_RENDER_DPI         = 300f;

    private Tesseract tesseract;
    private boolean ocrUnavailableLogged = false;

    private synchronized Tesseract tesseractInstance() {
        if (tesseract == null) {
            Tesseract t = new Tesseract();
            String dataPath = System.getenv("TESSDATA_PREFIX");
            if (dataPath != null && !dataPath.isBlank()) t.setDatapath(dataPath);
            tesseract = t;
        }
        return tesseract;
    }

    /** True if this page has essentially no extractable text but does contain image
     * content -- the scanned-page signature (confirmed live on VIKRAN's real filing:
     * zero-char pages, exactly one ~150-350KB JPEG each). */
    private boolean looksScanned(String pageText, PDPage page) {
        if (pageText != null && pageText.trim().length() > OCR_CANDIDATE_MAX_CHARS) return false;
        return pageHasImage(page);
    }

    private boolean pageHasImage(PDPage page) {
        try {
            PDResources resources = page.getResources();
            if (resources == null) return false;
            for (COSName name : resources.getXObjectNames()) {
                PDXObject xobject = resources.getXObject(name);
                if (xobject instanceof PDImageXObject) return true;
            }
        } catch (Exception e) {
            logger.warn("[PDF-OCR] Failed to inspect page resources: {}", e.getMessage());
        }
        return false;
    }

    /** Renders one page to a raster image and OCRs it. Returns null (never throws) if
     * the native Tesseract library isn't available or OCR otherwise fails -- callers
     * treat that identically to "no text found on this page", the same outcome as
     * before this fallback existed. */
    private String ocrPage(PDDocument doc, int pageIndex, String url) {
        try {
            PDFRenderer renderer = new PDFRenderer(doc);
            BufferedImage image = renderer.renderImageWithDPI(pageIndex, OCR_RENDER_DPI, ImageType.RGB);
            String text = tesseractInstance().doOCR(image);
            logger.info("[PDF-OCR] OCR'd page {} of {} -> {} chars", pageIndex + 1, url, text == null ? 0 : text.trim().length());
            return text;
        } catch (UnsatisfiedLinkError | NoClassDefFoundError | TesseractException e) {
            if (!ocrUnavailableLogged) {
                logger.warn("[PDF-OCR] OCR unavailable (native Tesseract library not found/working) -- " +
                        "scanned-image PDFs will keep failing to parse until this is fixed on the deploy. " +
                        "First failure: {}", e.getMessage());
                ocrUnavailableLogged = true;
            }
            return null;
        } catch (Exception e) {
            logger.warn("[PDF-OCR] Failed to OCR page {} of {}: {}", pageIndex + 1, url, e.getMessage());
            return null;
        }
    }

    /**
     * Downloads the PDF at {@code url} and returns its FULL extracted plain text (no
     * 4000-char truncation), or {@code null} if download/parsing fails. Use this
     * instead of {@link #extractText(String)} when the caller needs to locate content
     * that isn't guaranteed to be near the start of the document.
     *
     * Pages with no real text but image content get an OCR fallback pass -- see the
     * OCR fallback section above.
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
                return extractFullTextFromDocument(doc, url);
            }
        } catch (Exception e) {
            logger.warn("[PDF] Failed to extract full text from {}: {}", url, e.getMessage());
            return null;
        }
    }

    /** Per-page extraction loop, split out from extractFullText so it's directly
     * testable against an in-memory PDDocument (no live HTTP download needed). */
    private String extractFullTextFromDocument(PDDocument doc, String url) throws Exception {
        StringBuilder combined = new StringBuilder();
        PDFTextStripper stripper = new PDFTextStripper();
        int pageCount = doc.getNumberOfPages();
        int ocrPagesUsed = 0;
        for (int i = 0; i < pageCount; i++) {
            stripper.setStartPage(i + 1);
            stripper.setEndPage(i + 1);
            String pageText = stripper.getText(doc);

            if (looksScanned(pageText, doc.getPage(i))) {
                if (ocrPagesUsed < OCR_MAX_PAGES_PER_DOC) {
                    String ocrText = ocrPage(doc, i, url);
                    if (ocrText != null && !ocrText.isBlank()) {
                        pageText = ocrText;
                        ocrPagesUsed++;
                    }
                } else {
                    logger.warn("[PDF-OCR] {}: hit the {}-page OCR cap -- leaving remaining scanned pages as-is.",
                            url, OCR_MAX_PAGES_PER_DOC);
                }
            }
            combined.append(pageText);
        }
        String text = combined.toString().trim();
        logger.info("[PDF] Extracted {} chars (full{}) from {}",
                text.length(), ocrPagesUsed > 0 ? ", " + ocrPagesUsed + " page(s) OCR'd" : "", url);
        return text;
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
