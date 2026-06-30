package com.adil.nsealerts;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class BulletinController {

    private final MarketBulletinService bulletinService;

    public BulletinController(MarketBulletinService bulletinService) {
        this.bulletinService = bulletinService;
    }

    @GetMapping(value = "/trigger-bulletin", produces = MediaType.TEXT_PLAIN_VALUE)
    public String trigger(@RequestParam(defaultValue = "false") boolean preview) throws Exception {
        if (preview) {
            return bulletinService.buildBulletin();
        }
        new Thread(bulletinService::buildAndSend).start();
        return "Bulletin triggered — check Telegram in ~30 seconds.";
    }
}
