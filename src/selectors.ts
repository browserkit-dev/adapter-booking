/**
 * Booking.com DOM selectors — kept minimal.
 *
 * Booking.com uses React with hashed class names that rotate on deploys.
 * Content extraction uses innerText (see scraper.ts), NOT CSS class selectors.
 *
 * These selectors are used only for:
 *   1. isLoggedIn detection (auth state check)
 *   2. Waiting for page readiness before extracting innerText
 *
 * Auth flows span two subdomains:
 *   - www.booking.com       — main homepage, session cookies work here
 *   - secure.booking.com    — booking management (requires ?sid= query param)
 *   - account.booking.com   — OAuth / login flows
 *
 * KEY FINDING (discovered 2026-03-25):
 * Session cookies captured during login work on www.booking.com only.
 * secure.booking.com requires the ?sid=... query parameter in the URL.
 * The correct trips URL includes the sid:
 *   https://secure.booking.com/mytrips.html?sid=<sid>&aid=304142
 * The sid is found in the href of the "My bookings" link on www.booking.com.
 * loginUrl must be www.booking.com — navigate there first, then follow the mytrips link.
 *
 * TODO: After first login, inspect the detail page URL pattern and add a
 * comment here documenting the confirmed URL scheme for booking details.
 * Confirmed trips URL (2026-03-25):
 *   https://secure.booking.com/mytrips.html?aid=304142&label=gen173nr-...&sid=<session_id>
 * The sid param is generated client-side by Booking.com's JS from in-memory session data.
 * Navigation must happen via element.click() from www.booking.com (not page.goto()).
 * secure.booking.com blocks headless Chrome — adapter requires watch mode:
 *   browser({ action: "set_mode", mode: "watch" }) before calling booking tools.
 */

export const SELECTORS = {
  // ── Auth detection ─────────────────────────────────────────────────────────

  // Login page presence — email input or login form action
  loginForm: 'form[action*="login"], input[type="email"][name*="email"], input[autocomplete="email"]',

  // Account menu — only present when logged in
  // Note: data-testid values can change — check after login if this needs updating
  accountMenu: '[data-testid="account-menu"], [data-component="account-menu-button"]',

  // Fallback: "Sign in" button in header (only appears when logged out)
  signInButton: 'a[href*="/login"], button[data-action*="login"]',

  // ── Page readiness ─────────────────────────────────────────────────────────

  // Wait for any content on the trips page before extracting innerText
  // Falls back to body if none found (handled in scraper.ts)
  tripsContent: 'main, [role="main"], #bodyconstraint-inner, [data-testid="mytrips-layout"]',
} as const;
