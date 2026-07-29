'use strict';

/**
 * Upstox v2 order-placement client for the REAL-MONEY DarvasBox live
 * trade. The order-placement/fill-confirmation/LTP mechanics here are a
 * direct Node port of src/main/java/com/adil/nsealerts/UpstoxTradeService.java
 * -- an already-live, already-validated reference for this exact API
 * (that service places real orders for the announcement-rating strategy)
 * -- not a fresh guess at Upstox's API shape. getFunds/getPositions are
 * new (that reference doesn't need them, since it never restart-
 * reconciles); treat those two specifically as UNVERIFIED against the
 * real API until exercised, unlike placeOrder/waitForFill/getLtp.
 *
 * IMPORTANT: this module places REAL orders with REAL money the instant
 * placeOrder() is called. It has no dry-run mode of its own -- the
 * caller (live_tracker.js / streamer.js) is responsible for every gate
 * that decides WHETHER to call it (LIVE_TRADING_ENABLED, risk_manager,
 * position-already-open checks, etc.). This module only knows how to
 * talk to Upstox, not when it's safe to.
 */

const BASE_URL = 'https://api.upstox.com/v2';
const FETCH_TIMEOUT_MS = 10 * 1000;

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

class OrderClient {
  /** getAccessToken: () => string, called fresh on every request (token is refreshed daily, not cached at construction). */
  constructor(getAccessToken) {
    this.getAccessToken = getAccessToken;
  }

  _headers(extra = {}) {
    return { Authorization: `Bearer ${this.getAccessToken()}`, Accept: 'application/json', ...extra };
  }

  /**
   * Places a REAL market order. transactionType is 'BUY' or 'SELL'.
   * product 'I' = Intraday (MIS) -- required for SHORT entries (CNC
   * can't short), and matches this strategy's forced-EOD-square-off
   * design regardless of direction. Returns the Upstox order_id.
   * Throws on any failure -- callers must not treat a thrown error as
   * "no position", only as "unknown, go verify via getPositions/order
   * details before assuming anything."
   */
  async placeOrder(instrumentKey, quantity, transactionType) {
    const body = {
      quantity,
      product: 'I',
      validity: 'DAY',
      price: 0,
      tag: 'DARVASBOX_LIVE',
      instrument_token: instrumentKey,
      order_type: 'MARKET',
      transaction_type: transactionType,
      disclosed_quantity: 0,
      trigger_price: 0,
      is_amo: false,
    };
    const res = await fetchWithTimeout(`${BASE_URL}/order/place`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`placeOrder ${transactionType} ${instrumentKey} qty=${quantity} -> HTTP ${res.status}: ${text}`);
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`placeOrder: non-JSON response: ${text}`); }
    const orderId = json?.data?.order_id;
    if (!orderId) throw new Error(`placeOrder: no order_id in response: ${text}`);
    return orderId;
  }

  /**
   * Polls order/details for a terminal status (complete/rejected/cancelled).
   * Returns null (NOT a thrown error) if no terminal status is reached in
   * the attempt budget -- callers must treat null as "unconfirmed", never
   * as a filled position.
   */
  async waitForFill(orderId, { attempts = 8, delayMs = 500 } = {}) {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetchWithTimeout(`${BASE_URL}/order/details?order_id=${encodeURIComponent(orderId)}`, { headers: this._headers() });
        if (res.ok) {
          const json = await res.json();
          const data = json?.data || {};
          const status = String(data.status || '').toLowerCase();
          if (status === 'complete' || status === 'rejected' || status === 'cancelled') {
            return { status, avgPrice: Number(data.average_price) || 0, filledQty: Number(data.filled_quantity) || 0 };
          }
        }
      } catch (e) {
        console.warn(`  [OrderClient] waitForFill(${orderId}) attempt ${i + 1}/${attempts} error: ${e.message}`);
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return null;
  }

  /**
   * Last traded price. Tries the lightweight /market-quote/ltp endpoint
   * twice (covers brief quote gaps), then falls back to the heavier
   * /market-quote/quotes. Returns null only if all three attempts fail.
   */
  async getLtp(instrumentKey) {
    const encoded = encodeURIComponent(instrumentKey);
    let ltp = await this._fetchLastPrice(`${BASE_URL}/market-quote/ltp?instrument_key=${encoded}`);
    if (ltp != null) return ltp;
    await new Promise((r) => setTimeout(r, 300));
    ltp = await this._fetchLastPrice(`${BASE_URL}/market-quote/ltp?instrument_key=${encoded}`);
    if (ltp != null) return ltp;
    return this._fetchLastPrice(`${BASE_URL}/market-quote/quotes?instrument_key=${encoded}`);
  }

  /** Upstox keys the response by trading symbol (e.g. "NSE_EQ:SOLEX"), not by the instrument_key used in the request -- never assume the key, just take the first entry. */
  async _fetchLastPrice(url) {
    try {
      const res = await fetchWithTimeout(url, { headers: this._headers() });
      if (!res.ok) return null;
      const json = await res.json();
      const data = json?.data;
      if (!data) return null;
      const firstKey = Object.keys(data)[0];
      if (!firstKey) return null;
      const lp = Number(data[firstKey]?.last_price);
      return lp > 0 ? lp : null;
    } catch {
      return null;
    }
  }

  /**
   * UNVERIFIED against the real API (no existing reference for this call
   * in the repo) -- test this explicitly before relying on it to gate
   * real order placement. Expected shape: { equity: { available_margin, used_margin, ... } }.
   */
  async getFunds() {
    const res = await fetchWithTimeout(`${BASE_URL}/user/get-funds-and-margin?segment=SEC`, { headers: this._headers() });
    const text = await res.text();
    if (!res.ok) throw new Error(`getFunds HTTP ${res.status}: ${text}`);
    const json = JSON.parse(text);
    return json?.data?.equity || null;
  }

  /**
   * UNVERIFIED against the real API -- same caveat as getFunds(). Used
   * only for startup reconciliation (comparing in-memory tracker state
   * against Upstox's own record of real open positions), not on any hot
   * path.
   */
  async getPositions() {
    const res = await fetchWithTimeout(`${BASE_URL}/portfolio/short-term-positions`, { headers: this._headers() });
    const text = await res.text();
    if (!res.ok) throw new Error(`getPositions HTTP ${res.status}: ${text}`);
    const json = JSON.parse(text);
    return json?.data || [];
  }
}

module.exports = { OrderClient, BASE_URL };
