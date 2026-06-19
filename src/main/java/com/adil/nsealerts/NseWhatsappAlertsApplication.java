package com.adil.nsealerts;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class NseWhatsappAlertsApplication {
    public static void main(String[] args) {
        SpringApplication.run(NseWhatsappAlertsApplication.class, args);
    }
}
