package com.adil.nsealerts;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final DashboardAuthInterceptor dashboardAuthInterceptor;

    public WebMvcConfig(DashboardAuthInterceptor dashboardAuthInterceptor) {
        this.dashboardAuthInterceptor = dashboardAuthInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(dashboardAuthInterceptor)
                .addPathPatterns("/dashboard", "/dashboard/", "/api/dashboard/**");
    }
}
