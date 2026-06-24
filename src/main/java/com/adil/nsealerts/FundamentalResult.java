package com.adil.nsealerts;

import java.util.ArrayList;
import java.util.List;

public class FundamentalResult {
    private String symbol;
    private boolean available = true;
    private String unavailableMessage;

    private Double marketCapCr;
    private String marketCapCategory;

    private Double trailingPe;
    private Double industryPe;
    private String peRating;
    private String peComparison;

    private Double rocePercent;
    private String roceRating;

    private Double totalDebtCr;
    private String debtVsMarketCapRating;
    private String debtVsReserveRating;
    private Double debtToAssetsPercent;
    private String debtToAssetsRating;

    private List<Double> quarterlyRevenueCr = new ArrayList<>();
    private String quarterlyRevenueTrend;
    private List<Double> quarterlyNetProfitCr = new ArrayList<>();
    private String quarterlyNetProfitTrend;

    private Double trailingEps;

    private Double promoterHoldingPercent;
    private String promoterHoldingRating;

    private Double bookValue;
    private Double currentPrice;
    private Double priceToBookRatio;
    private String bookValueRating;

    private Double faceValue;
    private String faceValueRating;

    private Double ema200;
    private String ema200Rating;
    private Double rsi14;
    private String rsiRating;
    private Double fiftyTwoWeekHigh;
    private String breakoutRating;

    public String getSymbol() {
        return symbol;
    }

    public void setSymbol(String symbol) {
        this.symbol = symbol;
    }

    public boolean isAvailable() {
        return available;
    }

    public void setAvailable(boolean available) {
        this.available = available;
    }

    public String getUnavailableMessage() {
        return unavailableMessage;
    }

    public void setUnavailableMessage(String unavailableMessage) {
        this.unavailableMessage = unavailableMessage;
    }

    public Double getMarketCapCr() {
        return marketCapCr;
    }

    public void setMarketCapCr(Double marketCapCr) {
        this.marketCapCr = marketCapCr;
    }

    public String getMarketCapCategory() {
        return marketCapCategory;
    }

    public void setMarketCapCategory(String marketCapCategory) {
        this.marketCapCategory = marketCapCategory;
    }

    public Double getTrailingPe() {
        return trailingPe;
    }

    public void setTrailingPe(Double trailingPe) {
        this.trailingPe = trailingPe;
    }

    public Double getIndustryPe() {
        return industryPe;
    }

    public void setIndustryPe(Double industryPe) {
        this.industryPe = industryPe;
    }

    public String getPeRating() {
        return peRating;
    }

    public void setPeRating(String peRating) {
        this.peRating = peRating;
    }

    public String getPeComparison() {
        return peComparison;
    }

    public void setPeComparison(String peComparison) {
        this.peComparison = peComparison;
    }

    public Double getRocePercent() {
        return rocePercent;
    }

    public void setRocePercent(Double rocePercent) {
        this.rocePercent = rocePercent;
    }

    public String getRoceRating() {
        return roceRating;
    }

    public void setRoceRating(String roceRating) {
        this.roceRating = roceRating;
    }

    public Double getTotalDebtCr() {
        return totalDebtCr;
    }

    public void setTotalDebtCr(Double totalDebtCr) {
        this.totalDebtCr = totalDebtCr;
    }

    public String getDebtVsMarketCapRating() {
        return debtVsMarketCapRating;
    }

    public void setDebtVsMarketCapRating(String debtVsMarketCapRating) {
        this.debtVsMarketCapRating = debtVsMarketCapRating;
    }

    public String getDebtVsReserveRating() {
        return debtVsReserveRating;
    }

    public void setDebtVsReserveRating(String debtVsReserveRating) {
        this.debtVsReserveRating = debtVsReserveRating;
    }

    public Double getDebtToAssetsPercent() {
        return debtToAssetsPercent;
    }

    public void setDebtToAssetsPercent(Double debtToAssetsPercent) {
        this.debtToAssetsPercent = debtToAssetsPercent;
    }

    public String getDebtToAssetsRating() {
        return debtToAssetsRating;
    }

    public void setDebtToAssetsRating(String debtToAssetsRating) {
        this.debtToAssetsRating = debtToAssetsRating;
    }

    public List<Double> getQuarterlyRevenueCr() {
        return quarterlyRevenueCr;
    }

    public void setQuarterlyRevenueCr(List<Double> quarterlyRevenueCr) {
        this.quarterlyRevenueCr = quarterlyRevenueCr;
    }

    public String getQuarterlyRevenueTrend() {
        return quarterlyRevenueTrend;
    }

    public void setQuarterlyRevenueTrend(String quarterlyRevenueTrend) {
        this.quarterlyRevenueTrend = quarterlyRevenueTrend;
    }

    public List<Double> getQuarterlyNetProfitCr() {
        return quarterlyNetProfitCr;
    }

    public void setQuarterlyNetProfitCr(List<Double> quarterlyNetProfitCr) {
        this.quarterlyNetProfitCr = quarterlyNetProfitCr;
    }

    public String getQuarterlyNetProfitTrend() {
        return quarterlyNetProfitTrend;
    }

    public void setQuarterlyNetProfitTrend(String quarterlyNetProfitTrend) {
        this.quarterlyNetProfitTrend = quarterlyNetProfitTrend;
    }

    public Double getTrailingEps() {
        return trailingEps;
    }

    public void setTrailingEps(Double trailingEps) {
        this.trailingEps = trailingEps;
    }

    public Double getPromoterHoldingPercent() {
        return promoterHoldingPercent;
    }

    public void setPromoterHoldingPercent(Double promoterHoldingPercent) {
        this.promoterHoldingPercent = promoterHoldingPercent;
    }

    public String getPromoterHoldingRating() {
        return promoterHoldingRating;
    }

    public void setPromoterHoldingRating(String promoterHoldingRating) {
        this.promoterHoldingRating = promoterHoldingRating;
    }

    public Double getBookValue() {
        return bookValue;
    }

    public void setBookValue(Double bookValue) {
        this.bookValue = bookValue;
    }

    public Double getCurrentPrice() {
        return currentPrice;
    }

    public void setCurrentPrice(Double currentPrice) {
        this.currentPrice = currentPrice;
    }

    public Double getPriceToBookRatio() {
        return priceToBookRatio;
    }

    public void setPriceToBookRatio(Double priceToBookRatio) {
        this.priceToBookRatio = priceToBookRatio;
    }

    public String getBookValueRating() {
        return bookValueRating;
    }

    public void setBookValueRating(String bookValueRating) {
        this.bookValueRating = bookValueRating;
    }

    public Double getFaceValue() {
        return faceValue;
    }

    public void setFaceValue(Double faceValue) {
        this.faceValue = faceValue;
    }

    public String getFaceValueRating() {
        return faceValueRating;
    }

    public void setFaceValueRating(String faceValueRating) {
        this.faceValueRating = faceValueRating;
    }

    public Double getEma200() {
        return ema200;
    }

    public void setEma200(Double ema200) {
        this.ema200 = ema200;
    }

    public String getEma200Rating() {
        return ema200Rating;
    }

    public void setEma200Rating(String ema200Rating) {
        this.ema200Rating = ema200Rating;
    }

    public Double getRsi14() {
        return rsi14;
    }

    public void setRsi14(Double rsi14) {
        this.rsi14 = rsi14;
    }

    public String getRsiRating() {
        return rsiRating;
    }

    public void setRsiRating(String rsiRating) {
        this.rsiRating = rsiRating;
    }

    public Double getFiftyTwoWeekHigh() {
        return fiftyTwoWeekHigh;
    }

    public void setFiftyTwoWeekHigh(Double fiftyTwoWeekHigh) {
        this.fiftyTwoWeekHigh = fiftyTwoWeekHigh;
    }

    public String getBreakoutRating() {
        return breakoutRating;
    }

    public void setBreakoutRating(String breakoutRating) {
        this.breakoutRating = breakoutRating;
    }
}