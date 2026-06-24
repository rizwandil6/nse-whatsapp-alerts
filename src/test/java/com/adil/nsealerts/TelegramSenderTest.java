package com.adil.nsealerts;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpEntity;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.RestTemplate;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class TelegramSenderTest {

    private Environment env;
    private RestTemplate restTemplate;
    private TelegramSender sender;

    @BeforeEach
    void setUp() {
        env = mock(Environment.class);
        restTemplate = mock(RestTemplate.class);
        sender = new TelegramSender(env);
        ReflectionTestUtils.setField(sender, "botToken", "test-bot-token");
        ReflectionTestUtils.setField(sender, "restTemplate", restTemplate);
    }

    @Test
    void sendDoesNotCallApiWhenNoChatIdsConfigured() {
        when(env.getProperty("telegram.chat-ids[0]")).thenReturn(null);
        sender.send("Hello");
        verifyNoInteractions(restTemplate);
    }

    @Test
    void sendDoesNotCallApiWhenBotTokenIsBlank() {
        ReflectionTestUtils.setField(sender, "botToken", "");
        when(env.getProperty("telegram.chat-ids[0]")).thenReturn("12345");
        sender.send("Hello");
        verifyNoInteractions(restTemplate);
    }

    @Test
    void sendPostsToCorrectUrlForEachChatId() {
        when(env.getProperty("telegram.chat-ids[0]")).thenReturn("111");
        when(env.getProperty("telegram.chat-ids[1]")).thenReturn("222");
        when(env.getProperty("telegram.chat-ids[2]")).thenReturn(null);
        sender.send("Hello");
        verify(restTemplate, times(2)).postForObject(
                eq("https://api.telegram.org/bottest-bot-token/sendMessage"),
                any(HttpEntity.class),
                eq(String.class));
    }

    @Test
    @SuppressWarnings("unchecked")
    void sendIncludesChatIdAndTextInPayload() {
        when(env.getProperty("telegram.chat-ids[0]")).thenReturn("999");
        when(env.getProperty("telegram.chat-ids[1]")).thenReturn(null);
        sender.send("Test message");
        ArgumentCaptor<HttpEntity> captor = ArgumentCaptor.forClass(HttpEntity.class);
        verify(restTemplate).postForObject(any(), captor.capture(), eq(String.class));
        Map<String, String> body = (Map<String, String>) captor.getValue().getBody();
        assertThat(body).containsEntry("chat_id", "999");
        assertThat(body).containsEntry("text", "Test message");
    }

    @Test
    void sendSplitsLongMessagesIntoChunks() {
        when(env.getProperty("telegram.chat-ids[0]")).thenReturn("123");
        when(env.getProperty("telegram.chat-ids[1]")).thenReturn(null);
        String part1 = "A".repeat(4000) + "\n";
        String part2 = "B".repeat(200);
        sender.send(part1 + part2);
        verify(restTemplate, times(2)).postForObject(any(), any(HttpEntity.class), eq(String.class));
    }

    @Test
    void sendContinuesOnApiError() {
        when(env.getProperty("telegram.chat-ids[0]")).thenReturn("111");
        when(env.getProperty("telegram.chat-ids[1]")).thenReturn("222");
        when(env.getProperty("telegram.chat-ids[2]")).thenReturn(null);
        when(restTemplate.postForObject(any(), any(HttpEntity.class), eq(String.class)))
                .thenThrow(new RuntimeException("network error"))
                .thenReturn("ok");
        sender.send("Hello");
        verify(restTemplate, times(2)).postForObject(any(), any(HttpEntity.class), eq(String.class));
    }
}
