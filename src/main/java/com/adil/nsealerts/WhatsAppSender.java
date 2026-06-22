package com.adil.nsealerts;

import com.twilio.Twilio;
import com.twilio.rest.api.v2010.account.Message;
import com.twilio.type.PhoneNumber;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;

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

    public WhatsAppSender(Environment env) {
        this.env = env;
    }

    public void send(String message) {
        try {
            Twilio.init(accountSid, authToken);

            // Load recipients from YAML list using indexed properties
            List<String> whatsappTo = new ArrayList<>();
            int index = 0;
            String recipient;
            while ((recipient = env.getProperty("twilio.whatsapp-to[" + index + "]")) != null) {
                whatsappTo.add(recipient);
                index++;
            }

            if (whatsappTo.isEmpty()) {
                logger.warn("No Twilio recipients configured (twilio.whatsapp-to)");
                return;
            }

            logger.info("Sending message to {} recipients", whatsappTo.size());
            for (String to : whatsappTo) {
                try {
                    Message.creator(
                            new PhoneNumber("whatsapp:" + to),
                            new PhoneNumber("whatsapp:" + whatsappFrom),
                            message
                    ).create();
                    logger.info("  ✓ Sent to {}", to);
                } catch (Exception e) {
                    logger.warn("  ✗ Failed to send to {}", to, e);
                }
            }
        } catch (Exception e) {
            logger.error("Failed to send WhatsApp alert", e);
        }
    }
}
