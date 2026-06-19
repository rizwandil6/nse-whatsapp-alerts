package com.adil.nsealerts;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

@Service
public class WhatsAppSender {

    @Value("${callmebot.phone}")
    private String phone;

    @Value("${callmebot.apikey}")
    private String apiKey;

    private final RestTemplate restTemplate = new RestTemplate();

    public void send(String message) {
        String url = UriComponentsBuilder
                .fromHttpUrl("https://api.callmebot.com/whatsapp.php")
                .queryParam("phone", phone)
                .queryParam("text", message)
                .queryParam("apikey", apiKey)
                .toUriString();
        try {
            restTemplate.getForObject(url, String.class);
        } catch (Exception e) {
            System.err.println("Failed to send WhatsApp alert: " + e.getMessage());
        }
    }
}
