# NSE → WhatsApp Alerts

Polls NSE for watchlist stock announcements + exchange circulars (orders/contracts),
and sends matches to WhatsApp via CallMeBot.

## Setup

### 1. Get a CallMeBot API key (free)
- Save `+34 644 51 95 23` as a contact named "CallMeBot" in WhatsApp.
- Send it the message: `I allow callmebot to send me messages`
- You'll receive your API key in reply.

### 2. Configure
Edit `src/main/resources/application.yml`:
- `callmebot.phone` → your WhatsApp number with country code, no `+` (e.g. `919999999999`)
- `callmebot.apikey` → the key CallMeBot sent you
- `nse.watchlist` → your stock symbols (e.g. TCS, INFY)
- `nse.circular-keywords` → keywords to match in circular subjects (already set to orders/contracts)

### 3. Run (inside Codespaces / devcontainer)
```bash
mvn spring-boot:run
```

The app polls every 10 minutes (configurable via `nse.poll-interval-ms`) and
prints logs to console. No port/UI needed — it just runs as a background poller.

## Notes / known limitations
- **NSE bot protection:** the app first hits nseindia.com to grab session cookies
  before calling the API. NSE sometimes still blocks server IPs (including cloud/Codespaces
  IPs). If you see repeated fetch failures in the logs, route through a scraping proxy:
  set `proxy.base-url` in `application.yml` to a service like ScraperAPI or ScrapingBee.
- **Dedup is in-memory** — restarting the app will re-send alerts for items seen since
  last restart starts fresh. Fine for a personal alert tool; swap in a small DB if you
  want persistence across restarts.
- **Circulars endpoint** (`/api/circulars?dept=members`) may need adjusting — NSE's exact
  query params for the "orders/contracts" category can shift. Open browser dev tools on
  the exchange communication circulars page to confirm the live endpoint/params if results
  look off.
