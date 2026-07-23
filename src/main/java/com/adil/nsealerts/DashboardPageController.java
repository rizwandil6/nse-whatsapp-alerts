package com.adil.nsealerts;

import org.springframework.core.io.ClassPathResource;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Serves the dashboard shell as a controller route (not a static resource)
 * specifically so DashboardAuthInterceptor's path-pattern match on
 * "/dashboard" actually applies -- Spring's static resource handler runs
 * outside the normal interceptor chain unless registered separately, and
 * routing this through a controller sidesteps that entirely.
 */
@RestController
public class DashboardPageController {

    @GetMapping(value = "/dashboard", produces = MediaType.TEXT_HTML_VALUE)
    public String dashboardPage() throws IOException {
        return new String(new ClassPathResource("dashboard/index.html").getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    }
}
