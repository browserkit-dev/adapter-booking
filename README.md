# @browserkit-dev/adapter-booking

[Booking.com](https://www.booking.com) adapter for [browserkit](https://github.com/browserkit-dev/browserkit) — access your reservations, past trips, and booking details via your authenticated local browser session.

Authentication required. Runs entirely on your machine; no credentials leave localhost.

## Tools

| Tool | Key inputs | Description |
|---|---|---|
| `get_upcoming_bookings` | `count?` (1–50) | Your upcoming reservations with property, dates, price |
| `get_past_bookings` | `count?` (1–50) | Your past trips |
| `get_booking_details` | `confirmation_number` | Full details: check-in/out times, address, cancellation policy, payment summary |

Plus auto-registered management tools: `browser` (health check, screenshot, page state, mode switch, navigate), `close_session`.

## Setup

```bash
pnpm add @browserkit-dev/adapter-booking
```

```js
// browserkit.config.js
import { defineConfig } from "@browserkit-dev/core";

export default defineConfig({
  adapters: {
    "@browserkit-dev/adapter-booking": {
      port: 3850,
      channel: "chrome",  // required — Booking.com uses Cloudflare bot detection
    },
  },
});
```

```bash
# One-time login (opens a Chrome window — sign in normally)
browserkit login booking

# Start the daemon
browserkit start --config browserkit.config.js
```

Connect your MCP client to `http://127.0.0.1:3850/mcp`.

## Important: CloakBrowser required for account tools

`secure.booking.com` (where your bookings live) is protected by **DataDome** bot detection — it blocks standard headless Chrome. The booking adapter uses **CloakBrowser** (stealth Chromium with 33 C++-level patches) to bypass this.

Configure your `browserkit.config.js`:

```javascript
"/path/to/browserkit-adapter-booking/dist/index.js": {
  port: 3850,
  // Do NOT use channel: "chrome" — CloakBrowser uses its own Chromium binary
  antiDetection: {
    useCloakBrowser: true,
  },
},
```

CloakBrowser downloads its Chromium binary (~140MB) on first run and caches it. All tools work fully headlessly — **no watch mode required**.

## Usage

```
// List your upcoming trips
get_upcoming_bookings({ count: 5 })

// List past trips
get_past_bookings({ count: 10 })

// Get full details for a specific booking
get_booking_details({ confirmation_number: "1234567890" })
```

## How it works

Booking.com uses React with hashed class names that rotate on every deploy. This adapter uses an **`innerText` extraction strategy** — it navigates directly to `secure.booking.com/mytrips.html` and reads the page's text content. This is resilient to DOM changes.

Each tool returns:
- **Structured fields** (property name, dates, price) extracted best-effort
- **`rawText`** — the full card text for the LLM to parse any fields not in the structured output

The `get_booking_details` tool navigates to the individual booking's detail page (URL discovered from the trips list) for check-in instructions, property address, and cancellation policy.

### First use after login

After `browserkit login booking`, call `get_upcoming_bookings` and inspect the `detailUrl` field in the response. This reveals the Booking.com detail page URL pattern for your account. Document it in `src/selectors.ts` for reference.

## Tests

```bash
pnpm test                # L1 unit + L3 structural MCP (no Booking.com calls, CI-safe)
pnpm test:integration    # L2 live tests against real secure.booking.com (requires login)
```

Integration tests require an authenticated session — they are excluded from CI.

## License

MIT
