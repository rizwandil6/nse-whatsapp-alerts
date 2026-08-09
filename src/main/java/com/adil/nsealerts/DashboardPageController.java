package com.adil.nsealerts;

import org.springframework.core.io.ClassPathResource;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

@RestController
public class DashboardPageController {

    @GetMapping(value = "/dashboard", produces = MediaType.TEXT_HTML_VALUE)
    public String dashboardPage() throws IOException {
        return new String(new ClassPathResource("dashboard/index.html").getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    }
}
