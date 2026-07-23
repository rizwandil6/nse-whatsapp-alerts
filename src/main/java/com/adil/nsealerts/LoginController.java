package com.adil.nsealerts;

import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

@RestController
public class LoginController {
    private static final Logger logger = LoggerFactory.getLogger(LoginController.class);

    @Value("${dashboard.password:}")
    private String dashboardPassword;

    @GetMapping(value = "/login", produces = MediaType.TEXT_HTML_VALUE)
    public String loginPage(@RequestParam(required = false) String error) throws IOException {
        String html = new String(new ClassPathResource("dashboard/login.html").getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        return html.replace("{{ERROR}}", error != null ? "Wrong password — try again." : "");
    }

    @PostMapping(value = "/login")
    public void doLogin(@RequestParam String password, HttpSession session, HttpServletResponse response) throws IOException {
        if (dashboardPassword == null || dashboardPassword.isBlank()) {
            logger.warn("[LoginController] DASHBOARD_PASSWORD not set — refusing all logins.");
            response.sendRedirect("/login?error=1");
            return;
        }
        if (dashboardPassword.equals(password)) {
            session.setAttribute("dashboardAuthed", true);
            response.sendRedirect("/dashboard");
        } else {
            response.sendRedirect("/login?error=1");
        }
    }
}
