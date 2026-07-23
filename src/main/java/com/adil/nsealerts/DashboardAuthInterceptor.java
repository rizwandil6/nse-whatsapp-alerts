package com.adil.nsealerts;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * Gates /dashboard and /api/dashboard/** behind a session flag set by
 * LoginController after a correct password. No Spring Security dependency
 * in this project, so this is a minimal hand-rolled session check rather
 * than pulling in the full starter for a single shared-password gate.
 */
@Component
public class DashboardAuthInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        HttpSession session = request.getSession(false);
        boolean authed = session != null && Boolean.TRUE.equals(session.getAttribute("dashboardAuthed"));
        if (authed) return true;

        if (request.getRequestURI().startsWith("/api/")) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"not authenticated\"}");
        } else {
            response.sendRedirect("/login");
        }
        return false;
    }
}
