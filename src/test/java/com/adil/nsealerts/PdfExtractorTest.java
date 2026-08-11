package com.adil.nsealerts;

import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.Test;

import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;

import static org.junit.jupiter.api.Assertions.*;

/**
 * PdfExtractor's OCR fallback (2026-08-11) rewrote extractFullText's single
 * whole-document PDFTextStripper call into a per-page loop so scanned pages
 * (no text, but an image) can get an OCR pass spliced in -- see PdfExtractor's
 * OCR section docstring for the real incident (VIKRAN's filing: results-table
 * pages with zero embedded text, one large JPEG each). These tests don't
 * exercise real OCR output (no native Tesseract library in this test
 * environment -- see the repo-root Dockerfile) but DO verify: (1) the
 * per-page rewrite doesn't change extraction for ordinary text PDFs, and
 * (2) a missing native OCR library degrades gracefully (returns whatever
 * real text existed, never throws) rather than breaking the whole extraction.
 */
class PdfExtractorTest {

    private byte[] twoPageTextPdf() throws Exception {
        try (PDDocument doc = new PDDocument()) {
            for (String line : new String[]{"Statement of unaudited standalone financial results", "Second page line"}) {
                PDPage page = new PDPage(PDRectangle.A4);
                doc.addPage(page);
                try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
                    cs.beginText();
                    cs.setFont(PDType1Font.HELVETICA, 12);
                    cs.newLineAtOffset(50, 700);
                    cs.showText(line);
                    cs.endText();
                }
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            doc.save(out);
            return out.toByteArray();
        }
    }

    private byte[] textPageThenImageOnlyPagePdf() throws Exception {
        try (PDDocument doc = new PDDocument()) {
            PDPage textPage = new PDPage(PDRectangle.A4);
            doc.addPage(textPage);
            try (PDPageContentStream cs = new PDPageContentStream(doc, textPage)) {
                cs.beginText();
                cs.setFont(PDType1Font.HELVETICA, 12);
                cs.newLineAtOffset(50, 700);
                cs.showText("Statement of unaudited standalone financial results");
                cs.endText();
            }

            // Scanned-page stand-in: a page with an embedded raster image and NO text
            // drawn at all -- same signature confirmed live on VIKRAN's real filing
            // (results pages: 0 extracted chars, one large JPEG XObject each).
            PDPage imagePage = new PDPage(PDRectangle.A4);
            doc.addPage(imagePage);
            BufferedImage img = new BufferedImage(200, 200, BufferedImage.TYPE_INT_RGB);
            var g = img.createGraphics();
            g.setColor(Color.WHITE);
            g.fillRect(0, 0, 200, 200);
            g.dispose();
            var pdImage = LosslessFactory.createFromImage(doc, img);
            try (PDPageContentStream cs = new PDPageContentStream(doc, imagePage)) {
                cs.drawImage(pdImage, 50, 500, 200, 200);
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            doc.save(out);
            return out.toByteArray();
        }
    }

    /** Reflection helper -- looksScanned/pageHasImage are private, tested here as
     * the exact detection logic extractFullText relies on, without needing a live
     * HTTP download (extractFullText's public entry point requires a URL). */
    private boolean invokeLooksScanned(PdfExtractor extractor, String pageText, PDPage page) throws Exception {
        Method m = PdfExtractor.class.getDeclaredMethod("looksScanned", String.class, PDPage.class);
        m.setAccessible(true);
        return (boolean) m.invoke(extractor, pageText, page);
    }

    @Test
    void looksScanned_trueForNoTextPageWithImage_falseForTextPage() throws Exception {
        PdfExtractor extractor = new PdfExtractor();
        try (PDDocument doc = PDDocument.load(textPageThenImageOnlyPagePdf())) {
            PDFTextStripper stripper = new PDFTextStripper();

            stripper.setStartPage(1);
            stripper.setEndPage(1);
            String page1Text = stripper.getText(doc);
            assertFalse(invokeLooksScanned(extractor, page1Text, doc.getPage(0)),
                    "page with real text should not look scanned, even if OCR were unavailable");

            stripper.setStartPage(2);
            stripper.setEndPage(2);
            String page2Text = stripper.getText(doc);
            assertTrue(invokeLooksScanned(extractor, page2Text, doc.getPage(1)),
                    "page with no text but an embedded image should look scanned");
        }
    }

    @Test
    void extractFullText_perPageLoop_matchesWholeDocumentExtraction_forOrdinaryTextPdf() throws Exception {
        byte[] pdfBytes = twoPageTextPdf();
        String viaWholeDoc;
        try (PDDocument doc = PDDocument.load(pdfBytes)) {
            viaWholeDoc = new PDFTextStripper().getText(doc).trim();
        }

        String viaExtractor = extractFullTextFromBytes(pdfBytes);
        assertNotNull(viaExtractor);
        assertTrue(viaExtractor.contains("Statement of unaudited standalone financial results"));
        assertTrue(viaExtractor.contains("Second page line"));
        // Not asserting byte-identical (page-scoped extraction can differ from a single
        // whole-document call by incidental whitespace at page boundaries), but content
        // and ordering must match.
        assertEquals(normalize(viaWholeDoc), normalize(viaExtractor));
    }

    @Test
    void extractFullText_imageOnlyPage_degradesGracefully_keepsTextFromOtherPages() throws Exception {
        // No native Tesseract library in this test environment -- ocrPage() must catch
        // that (UnsatisfiedLinkError/NoClassDefFoundError/TesseractException) and return
        // null, and extractFullText must still return the real text page's content
        // rather than throwing or returning null for the whole document.
        String text = extractFullTextFromBytes(textPageThenImageOnlyPagePdf());
        assertNotNull(text);
        assertTrue(text.contains("Statement of unaudited standalone financial results"));
    }

    private String normalize(String s) {
        return s.replaceAll("\\s+", " ").trim();
    }

    /** extractFullText() only accepts a URL (it owns the download); this reflects
     * into the same per-page-loop code path against an in-memory PDDocument built
     * from bytes, so these tests don't need a live HTTP fetch. */
    private String extractFullTextFromBytes(byte[] pdfBytes) throws Exception {
        PdfExtractor extractor = new PdfExtractor();
        try (PDDocument doc = PDDocument.load(pdfBytes)) {
            Method m = PdfExtractor.class.getDeclaredMethod("extractFullTextFromDocument", PDDocument.class, String.class);
            m.setAccessible(true);
            return (String) m.invoke(extractor, doc, "test.pdf");
        }
    }
}
