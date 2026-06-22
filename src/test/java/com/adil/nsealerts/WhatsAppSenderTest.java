package com.adil.nsealerts;

import com.twilio.Twilio;
import com.twilio.rest.api.v2010.account.Message;
import com.twilio.rest.api.v2010.account.MessageCreator;
import com.twilio.type.PhoneNumber;
import org.junit.jupiter.api.Test;
import org.mockito.MockedStatic;
import org.springframework.core.env.Environment;
import org.springframework.test.util.ReflectionTestUtils;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class WhatsAppSenderTest {

    @Test
    void sendDoesNotFailWhenNoRecipientsAreConfigured() {
        Environment env = mock(Environment.class);
        when(env.getProperty("twilio.whatsapp-to[0]")).thenReturn(null);

        WhatsAppSender sender = new WhatsAppSender(env);
        ReflectionTestUtils.setField(sender, "accountSid", "sid");
        ReflectionTestUtils.setField(sender, "authToken", "token");
        ReflectionTestUtils.setField(sender, "whatsappFrom", "+14155552671");

        try (MockedStatic<Twilio> twilioMock = mockStatic(Twilio.class);
             MockedStatic<Message> messageMock = mockStatic(Message.class)) {
            sender.send("Hello");
            messageMock.verifyNoInteractions();
        }
    }

    @Test
    void sendSendsMessageToConfiguredRecipients() {
        Environment env = mock(Environment.class);
        when(env.getProperty("twilio.whatsapp-to[0]")).thenReturn("+14155550000");
        when(env.getProperty("twilio.whatsapp-to[1]")).thenReturn(null);

        WhatsAppSender sender = new WhatsAppSender(env);
        ReflectionTestUtils.setField(sender, "accountSid", "sid");
        ReflectionTestUtils.setField(sender, "authToken", "token");
        ReflectionTestUtils.setField(sender, "whatsappFrom", "+14155552671");

        MessageCreator creator = mock(MessageCreator.class);
        when(creator.create()).thenReturn(mock(Message.class));

        try (MockedStatic<Twilio> twilioMock = mockStatic(Twilio.class);
             MockedStatic<Message> messageMock = mockStatic(Message.class)) {
            messageMock.when(() -> Message.creator(any(PhoneNumber.class), any(PhoneNumber.class), eq("Hello")))
                    .thenReturn(creator);

            sender.send("Hello");

            messageMock.verify(() -> Message.creator(any(PhoneNumber.class), any(PhoneNumber.class), eq("Hello")), times(1));
            verify(creator, times(1)).create();
        }
    }
}
