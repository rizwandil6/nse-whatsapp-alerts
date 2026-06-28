package com.adil.nsealerts;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class DailyBulletinScheduler {

    private static final Logger logger = LoggerFactory.getLogger(DailyBulletinScheduler.class);

    private final MarketBulletinService bulletinService;

    public DailyBulletinScheduler(MarketBulletinService bulletinService) {
        this.bulletinService = bulletinService;
    }

    /**
     * Fires every day at 7:30 AM IST, including weekends.
     * cron = second minute hour day month weekday
     */
    @Scheduled(cron = "0 30 7 * * *", zone = "Asia/Kolkata")
    public void sendDailyBulletin() {
        logger.info("[DailyBulletin] Triggered at 7:30 AM IST");
        bulletinService.buildAndSend();
    }
}
