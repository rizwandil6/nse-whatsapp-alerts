package com.adil.nsealerts;

import com.twilio.Twilio;
import com.twilio.rest.api.v2010.account.Message;
import com.twilio.type.PhoneNumber;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

@Service
public class WhatsAppSender {

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
                System.out.println("No Twilio recipients configured (twilio.whatsapp-to)");
                return;
            }

            System.out.println("Sending message to " + whatsappTo.size() + " recipients");
            for (String to : whatsappTo) {
                try {
                    Message.creator(
                            new PhoneNumber("whatsapp:" + to),
                            new PhoneNumber("whatsapp:" + whatsappFrom),
                            message
                    ).create();
                    System.out.println("  ✓ Sent to " + to);
                } catch (Exception e) {
                    System.out.println("  ✗ Failed to send to " + to + ": " + e.getMessage());
                }
            }
        } catch (Exception e) {
            System.out.println("Failed to send WhatsApp alert: " + e.getMessage());
            e.printStackTrace();
        }
    }
}
