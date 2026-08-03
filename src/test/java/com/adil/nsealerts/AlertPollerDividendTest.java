package com.adil.nsealerts;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.core.env.Environment;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Real incident, 2026-08-03: Great Eastern Shipping filed its dividend declaration and
 * record date as two SEPARATE NSE announcements ("SUBJECT: Dividend" / "SUBJECT: Record
 * Date"), not embedded in the "Outcome of Board Meeting" results filing. These fixtures
 * use the exact real description text from those two announcements.
 */
class AlertPollerDividendTest {

    private TelegramSender telegramSender;
    private AlertLogService alertLogService;
    private AlertPoller poller;
    private Class<?> ctxClass;

    @BeforeEach
    void setUp() throws Exception {
        NseClient nseClient = mock(NseClient.class);
        telegramSender = mock(TelegramSender.class);
        FundamentalScreener fundamentalScreener = mock(FundamentalScreener.class);
        PromptRatingService promptRatingService = mock(PromptRatingService.class);
        PdfExtractor pdfExtractor = mock(PdfExtractor.class);
        ScreenerCheckService screenerCheckService = mock(ScreenerCheckService.class);
        UpstoxTradeService upstoxTradeService = mock(UpstoxTradeService.class);
        alertLogService = mock(AlertLogService.class);
        QuarterlyResultsService quarterlyResultsService = mock(QuarterlyResultsService.class);
        Environment env = mock(Environment.class);

        // Only "GESHIP" on the watchlist -- one indexed entry, then the loop-terminating null
        // (every other indexed-list property -- announcement-keywords, alert-only-keywords,
        // ignore-keywords -- is left unstubbed, so Mockito's default null return terminates
        // those loops immediately at index 0; irrelevant to this test either way).
        when(env.getProperty("nse.watchlist[0]")).thenReturn("GESHIP");
        // Plain string properties fall back to whatever default the caller passed.
        when(env.getProperty(anyString(), anyString())).thenAnswer(inv -> inv.getArgument(1));

        poller = new AlertPoller(nseClient, telegramSender, fundamentalScreener, promptRatingService,
                pdfExtractor, screenerCheckService, upstoxTradeService, alertLogService,
                quarterlyResultsService, env);

        ctxClass = Class.forName("com.adil.nsealerts.AlertPoller$AnnouncementContext");
    }

    private Object newContext(String companyName, String symbol, String subject, String link) throws Exception {
        Constructor<?> ctor = ctxClass.getDeclaredConstructor(
                String.class, String.class, String.class, String.class, String.class, long.class);
        ctor.setAccessible(true);
        return ctor.newInstance(companyName, symbol, subject, link, "03-Aug-2026 17:01:05", 0L);
    }

    private void invokeHandleDividendAnnouncement(Object ctx, boolean isRecordDate) throws Exception {
        Method m = AlertPoller.class.getDeclaredMethod("handleDividendAnnouncement", ctxClass, boolean.class);
        m.setAccessible(true);
        m.invoke(poller, ctx, isRecordDate);
    }

    @Test
    void extractsDividendAmountFromRealDescriptionText() throws Exception {
        String description = "The Great Eastern Shipping Company Limited has informed the Exchange that Board of "
                + "Directors at its meeting held on August 03, 2026, declared Interim Dividend of Rs. 14.40 per "
                + "equity share. |SUBJECT: Dividend";
        Object ctx = newContext("The Great Eastern Shipping Company Limited", "GESHIP", description,
                "https://nsearchives.nseindia.com/corporate/GESHIP_03082026170021_resultstobefiled.pdf");

        invokeHandleDividendAnnouncement(ctx, false);

        ArgumentCaptor<String> messageCaptor = ArgumentCaptor.forClass(String.class);
        verify(telegramSender).send(messageCaptor.capture(), eq("Markdown"));
        String message = messageCaptor.getValue();
        assertTrue(message.contains("DIVIDEND ALERT"), message);
        assertTrue(message.contains("Amount: Rs. 14.40 per equity share"), message);
        verify(alertLogService).logAnnouncement(eq("GESHIP"), anyString(), anyString(), eq("DIVIDEND_ALERT"), anyString());
    }

    @Test
    void extractsRecordDateFromRealDescriptionText() throws Exception {
        String description = "The Great Eastern Shipping Company Limited has informed the Exchange that Record "
                + "date for the purpose of Dividend  is 07-Aug-2026. |SUBJECT: Record Date";
        Object ctx = newContext("The Great Eastern Shipping Company Limited", "GESHIP", description,
                "https://nsearchives.nseindia.com/corporate/GESHIP_03082026170318_lettertobefiled.pdf");

        invokeHandleDividendAnnouncement(ctx, true);

        ArgumentCaptor<String> messageCaptor = ArgumentCaptor.forClass(String.class);
        verify(telegramSender).send(messageCaptor.capture(), eq("Markdown"));
        String message = messageCaptor.getValue();
        assertTrue(message.contains("DIVIDEND ALERT"), message);
        assertTrue(message.contains("Record Date: 07-Aug-2026"), message);
    }

    @Test
    void suppressedWhenSymbolIsNotOnTheWatchlist() throws Exception {
        String description = "Some Other Company has informed the Exchange that Board of Directors declared "
                + "Interim Dividend of Rs. 5.00 per equity share. |SUBJECT: Dividend";
        Object ctx = newContext("Some Other Company", "NOTONLIST", description,
                "https://nsearchives.nseindia.com/corporate/NOTONLIST_03082026170021_outcome.pdf");

        invokeHandleDividendAnnouncement(ctx, false);

        verify(telegramSender, never()).send(anyString(), anyString());
    }
}
