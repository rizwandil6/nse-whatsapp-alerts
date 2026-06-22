package com.adil.nsealerts;

import com.twilio.Twilio;
import com.twilio.rest.api.v2010.account.Message;
import com.twilio.type.PhoneNumber;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.util.ArrayList;
import java.util.List;

@Service
public class WhatsAppSender {
    private static final Logger logger = LoggerFactory.getLogger(WhatsAppSender.class);

    @Value("${twilio.account-sid}")
    private String accountSid;

    @Value("${twilio.auth-token}")
    private String authToken;

    @Value("${twilio.whatsapp-from}")
    private String whatsappFrom;

    private final Environment env;
    private volatile boolean twilioInitialized;

    public WhatsAppSender(Environment env) {
        this.env = env;
    }

    @PostConstruct
    void logTwilioConfiguration() {
        logger.info("Twilio config loaded: accountSid={}, authTokenSet={}, whatsappFrom={}, recipients={}",
                maskAccountSid(accountSid),
                authToken != null && !authToken.isBlank(),
                whatsappFrom,
                loadRecipients().size());
    }

    public void send(String body) {
        List<String> recipients = loadRecipients();
        if (recipients.isEmpty()) {
            logger.warn("No WhatsApp recipients configured; skipping send");
            return;
        }

        initializeTwilio();

        for (String recipient : recipients) {
            sendToRecipient(recipient, body);
        }
    }

    private void initializeTwilio() {
        if (twilioInitialized) {
            return;
        }

        synchronized (this) {
            if (twilioInitialized) {
                return;
            }
            Twilio.init(accountSid, authToken);
            twilioInitialized = true;
        }
    }

    private List<String> loadRecipients() {
        List<String> recipients = new ArrayList<>();
        int index = 0;
        String recipient;
        while ((recipient = env.getProperty("twilio.whatsapp-to[" + index + "]")) != null) {
            String trimmed = recipient.trim();
            if (!trimmed.isEmpty()) {
                recipients.add(trimmed);
            }
            index++;
        }
        logger.debug("Loaded {} WhatsApp recipients", recipients.size());
        return recipients;
    }

    private void sendToRecipient(String to, String body) {
        try {
            Message message = Message.creator(
                    new PhoneNumber("whatsapp:" + to),
                    new PhoneNumber("whatsapp:" + whatsappFrom),
                    body)
                .create();
            logger.info("Sent message to {}: {}", to, message.getSid());
        } catch (com.twilio.exception.ApiException e) {
            logger.error("Twilio ApiException sending to {}: status={}, code={}, msg={}, accountSid={}",
                    to,
                    e.getStatusCode(),
                    e.getCode(),
                    e.getMessage(),
                    maskAccountSid(accountSid),
                    e);
        } catch (Exception e) {
            logger.error("Unexpected exception sending WhatsApp to {}", to, e);
        }
    }

    private String maskAccountSid(String value) {
        if (value == null || value.isBlank()) {
            return "<empty>";
        }
        if (value.length() <= 6) {
            return "***";
        }
        return value.substring(0, 4) + "***" + value.substring(value.length() - 4);
    }
}
