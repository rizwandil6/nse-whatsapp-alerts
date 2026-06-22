package com.adil.nsealerts;

public class AnalysisResult {
    private final double rating;
    private final Double orderSizeCrores;
    private final String quickVerdict;
    private final String summary;
    private final String impactLevel;
    private final String whatsappMessage;

    public AnalysisResult(double rating, Double orderSizeCrores, String quickVerdict, String summary, String impactLevel) {
        this(rating, orderSizeCrores, quickVerdict, summary, impactLevel, null);
    }

    public AnalysisResult(double rating, Double orderSizeCrores, String quickVerdict, String summary, String impactLevel, String whatsappMessage) {
        this.rating = rating;
        this.orderSizeCrores = orderSizeCrores;
        this.quickVerdict = quickVerdict != null && !quickVerdict.isBlank() ? quickVerdict : "No quick verdict";
        this.summary = summary;
        this.impactLevel = impactLevel;
        this.whatsappMessage = whatsappMessage;
    }

    public double getRating() {
        return rating;
    }

    public Double getOrderSizeCrores() {
        return orderSizeCrores;
    }

    public String getQuickVerdict() {
        return quickVerdict;
    }

    public String getSummary() {
        return summary;
    }

    public String getImpactLevel() {
        return impactLevel;
    }

    public String getWhatsappMessage() {
        return whatsappMessage;
    }
}
