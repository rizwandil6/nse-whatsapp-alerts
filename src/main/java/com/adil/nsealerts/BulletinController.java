package com.adil.nsealerts;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class BulletinController {

    private final MarketBulletinService bulletinService;

    public BulletinController(MarketBulletinService bulletinService) {
        this.bulletinService = bulletinService;
    }

    @GetMapping("/trigger-bulletin")
    public String trigger() {
        new Thread(bulletinService::buildAndSend).start();
        return "Bulletin triggered — check Telegram in ~30 seconds.";
    }
}
