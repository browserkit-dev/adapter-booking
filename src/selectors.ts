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
 *   - secure.booking.com  — My trips, reservation management
 *   - account.booking.com — OAuth / login flows
 *
 * TODO: After first login, inspect the detail page URL pattern and add a
 * comment here documenting the confirmed URL scheme for booking details.
 * Likely: secure.booking.com/mybooking.html?confirmation_id=...
 * or:     secure.booking.com/myreservations.html?bn=...&pin=...
 */

export const SELECTORS = {
  // ── Auth detection ─────────────────────────────────────────────────────────

  // Login page presence — email input or login form action
  loginForm: 'form[action*="login"], input[type="email"][name*="email"], input[autocomplete="email"]',

  // Account menu — only present when logged in
  // Note: data-testid values can change — check after login if this needs updating
  accountMenu: '[data-testid="account-menu"], [data-component="account-menu-button"], [aria-label*="Account"], [aria-label*="account"]',

  // Fallback: "Sign in" button in header (only appears when logged out)
  signInButton: 'a[href*="/login"], button[data-action*="login"]',

  // ── Page readiness ─────────────────────────────────────────────────────────

  // Wait for any content on the trips page before extracting innerText
  // Falls back to body if none found (handled in scraper.ts)
  tripsContent: 'main, [role="main"], #bodyconstraint-inner, [data-testid="mytrips-layout"]',
} as const;
