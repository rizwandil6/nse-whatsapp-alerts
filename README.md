# NSE → WhatsApp Alerts

Polls NSE for watchlist stock announcements (via public RSS feed) + exchange circulars (orders/contracts via JSON API),
and sends matches to WhatsApp via Twilio.

## Setup

### 1. Get Twilio credentials (paid, but reliable)
- Sign up at [Twilio.com](https://www.twilio.com/)
- Create a WhatsApp sender sandbox (or production number)
- Get your Account SID and Auth Token from the Twilio dashboard
- Get your WhatsApp-enabled phone number from Twilio

### 2. Configure
Edit `src/main/resources/application.yml`:
- `twilio.account-sid` → your Twilio Account SID
- `twilio.auth-token` → your Twilio Auth Token
- `twilio.whatsapp-from` → your Twilio WhatsApp number (e.g. `+1234567890`)
 - `twilio.whatsapp-to` → one or more WhatsApp recipient numbers. In `application.yml` provide as a YAML list:
   ```yaml
   twilio:
     whatsapp-to:
       - "+919999999999"
       - "+919888888888"
   ```
- `nse.watchlist` → your stock symbols to match in announcements (e.g. TCS, INFY)
- `nse.circular-keywords` → keywords to match in circular subjects (already set to orders/contracts)
- `proxy.base-url` → optional scraping proxy base URL for circulars JSON API (announcements use public RSS, no proxy needed)
- `proxy.auth-header` → optional HTTP header name for proxy auth (e.g. `x-api-key`)
- `proxy.auth-token` → optional HTTP header value for proxy auth

Example ScraperAPI configuration for circulars (if needed):
```yaml
proxy:
  base-url: "https://api.scraperapi.com/?api_key=YOUR_API_KEY&url="
  auth-header: ""
  auth-token: ""
```

### 3. Run (inside Codespaces / devcontainer)
```bash
mvn spring-boot:run
```

The app polls every 10 minutes (configurable via `nse.poll-interval-ms`) and
prints logs to console. No port/UI needed — it just runs as a background poller.

## Notes / known limitations
- **Announcements via RSS:** uses a public RSS feed (no cookies or session handling needed),
  so it's reliable and doesn't require proxy workarounds.
- **Circulars via JSON API:** still uses the JSON API, which may be blocked by NSE's bot
  protection. If you see repeated fetch failures for circulars, route through a scraping
  proxy: set `proxy.base-url` in `application.yml` to a service like ScraperAPI or ScrapingBee.
- **Dedup is in-memory** — restarting the app will re-send alerts for items seen since last
  restart. Fine for a personal alert tool; swap in a small DB if you want persistence.
- **Circulars endpoint** (`/api/circulars?dept=members`) may need adjusting — NSE's exact
  query params for the "orders/contracts" category can shift. Open browser dev tools on
  the exchange communication circulars page to confirm the live endpoint/params if results
  look off.
