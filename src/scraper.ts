/**
 * Booking.com extraction engine using innerText navigation.
 *
 * Design philosophy:
 * - Navigate directly to section URLs rather than clicking UI elements
 * - Extract innerText of the main content area (NOT CSS class selectors)
 * - Booking.com uses React with hashed class names that rotate on deploys
 * - Return rawText alongside best-effort structured fields so the LLM can
 *   parse the text if structured extraction is incomplete
 *
 * The extraction functions navigate to the relevant URL, wait for the DOM
 * to stabilise, then read innerText. All content interpretation is left to
 * the calling LLM.
 */

import type { Page } from "patchright";
import { SELECTORS } from "./selectors.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type TripStatus = "upcoming" | "past" | "cancelled";

export interface Booking {
  /** Booking confirmation/reference number, e.g. "1234567890" */
  confirmationNumber: string;
  /** Property name */
  propertyName: string;
  /** City and country, e.g. "Amsterdam, Netherlands" */
  location: string;
  /** Check-in date (ISO format YYYY-MM-DD, best-effort) */
  checkIn: string;
  /** Check-out date (ISO format YYYY-MM-DD, best-effort) */
  checkOut: string;
  /** Number of nights (best-effort, 0 if not parseable) */
  nights: number;
  /** Total price as displayed, e.g. "€ 320" */
  totalPrice: string;
  /** Trip status */
  status: TripStatus;
  /**
   * URL of the booking detail page — captured from the "View booking" link.
   * This is the key field for get_booking_details.
   * NOTE: URL pattern is discovered at runtime — document it in selectors.ts
   * after first login.
   */
  detailUrl: string;
  /** Full innerText of the booking card — the LLM should use this for any
   * fields not in the structured output above */
  rawText: string;
}

export interface BookingDetail extends Booking {
  /** Full property address */
  propertyAddress: string;
  /** Check-in time instructions, e.g. "Check-in from 14:00" */
  checkInTime: string;
  /** Check-out time instructions, e.g. "Check-out until 11:00" */
  checkOutTime: string;
  /** Property contact phone number */
  contactPhone: string;
  /** Special requests submitted at booking time */
  specialRequests: string;
  /** Cancellation policy text */
  cancellationPolicy: string;
  /** Payment summary text (total paid, payment method) */
  paymentSummary: string;
}

// ── URL extraction ────────────────────────────────────────────────────────────

/**
 * Navigate to secure.booking.com/mytrips.html via a JS click from www.booking.com.
 *
 * IMPORTANT: secure.booking.com blocks headless Chrome (ERR_TOO_MANY_REDIRECTS).
 * This adapter MUST run in watch mode to access the trips page:
 *   browser({ action: "set_mode", mode: "watch" })
 *   get_upcoming_bookings({ count: 5 })
 *
 * The mytrips link on www.booking.com uses native element.click() which triggers
 * the JS session initialization (sid generation) that page.goto() bypasses.
 *
 * Confirmed URL pattern (discovered 2026-03-25):
 *   https://secure.booking.com/mytrips.html?aid=304142&label=gen173nr-...&sid=<session_id>
 */
async function navigateToTripsPage(page: Page, status: TripStatus): Promise<void> {
  // Step 1: ensure we're on www.booking.com with full JS initialized
  if (!page.url().includes("www.booking.com")) {
    await page.goto("https://www.booking.com/", {
      waitUntil: "networkidle",
      timeout: 25_000,
    });
    await page.waitForTimeout(1_500);
  }

  await page.waitForTimeout(500);

  // Step 2: click the mytrips link via native JS element.click()
  // Playwright's locator.click() times out on this element due to patchright's
  // performance monitoring. Native JS click() triggers the same JS navigation.
  const clicked = await page.evaluate((): boolean => {
    const link = document.querySelector('a[href*="mytrips"]') as HTMLAnchorElement | null;
    if (link) {
      link.click();
      return true;
    }
    const btn = document.querySelector(
      '[data-testid="header-account-menu-trigger"], [data-testid="account-menu"]'
    ) as HTMLElement | null;
    if (btn) {
      btn.click();
      return false;
    }
    return false;
  });

  if (!clicked) {
    await page.waitForTimeout(600);
    const didClick = await page.evaluate((): boolean => {
      const link = document.querySelector('a[href*="mytrips"]') as HTMLAnchorElement | null;
      if (link) { link.click(); return true; }
      return false;
    });
    if (!didClick) {
      throw new Error(
        "Could not find My bookings link on www.booking.com. " +
        "Make sure you are logged in (run: browserkit login booking)."
      );
    }
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  await page.waitForTimeout(1_500);

  // Check if navigation was blocked (headless mode)
  const currentUrl = page.url();
  if (currentUrl.includes("chromewebdata") || currentUrl.includes("chrome-error://")) {
    throw new Error(
      "Booking.com's secure.booking.com requires headed (watch) mode — " +
      "it blocks headless Chrome. Switch to watch mode first:\n" +
      "  browser({ action: 'set_mode', mode: 'watch' })\n" +
      "Then retry your booking tool call."
    );
  }

  // Append status filter if needed
  if (status !== "upcoming" && page.url().includes("mytrips")) {
    const u = new URL(page.url());
    u.searchParams.set("status", status);
    await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
  }
}

// ── Text parsing helpers ──────────────────────────────────────────────────────

/**
 * Extract a date string from text near a keyword (check-in / check-out).
 * Returns empty string if not found.
 * Booking.com formats vary: "15 Apr 2026", "Apr 15, 2026", "2026-04-15"
 */
export function extractDateNear(text: string, keyword: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx === -1) return "";
  const snippet = text.slice(idx, idx + 80);
  // ISO date
  const iso = snippet.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (iso) return iso;
  // "15 Apr 2026" or "Apr 15, 2026"
  const human = snippet.match(/\b(\d{1,2}\s+\w{3}\s+\d{4}|\w{3}\s+\d{1,2},?\s+\d{4})\b/)?.[1];
  return human ?? "";
}

/**
 * Extract a price string from text. Returns the first currency-like match.
 */
export function extractPrice(text: string): string {
  const match = text.match(/[€£$¥₹]\s*[\d,]+(?:\.\d{2})?|[\d,]+(?:\.\d{2})?\s*[€£$¥₹]/);
  return match?.[0]?.trim() ?? "";
}

/**
 * Extract a confirmation/reference number.
 * Booking.com shows these as "Confirmation: 1234567890" or "PIN: 1234".
 */
export function extractConfirmationNumber(text: string): string {
  const match = text.match(/(?:confirmation|reference|booking)[\s#:]*([A-Z0-9]{6,12})/i);
  return match?.[1]?.trim() ?? "";
}

/**
 * Count nights between two date strings (YYYY-MM-DD).
 * Returns 0 if parsing fails.
 */
export function countNights(checkIn: string, checkOut: string): number {
  try {
    const a = new Date(checkIn).getTime();
    const b = new Date(checkOut).getTime();
    if (isNaN(a) || isNaN(b) || b <= a) return 0;
    return Math.round((b - a) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

/** Kept for unit test compatibility only */
export function tripsUrl(status: TripStatus): string {
  return `https://secure.booking.com/mytrips.html?status=${status}`;
}

// ── Page extraction ───────────────────────────────────────────────────────────

/**
 * Extract trip group cards from the mytrips page.
 * Booking.com groups bookings by destination trip (e.g. "California and Arizona").
 * Each card shows: destination, date range, booking count, thumbnail.
 *
 * Confirmed page structure (2026-03-25):
 *   secure.booking.com/mytrips.html shows trip groups, not individual hotel cards.
 *   The page has tabs: upcoming (default) | past | cancelled.
 *   Trip groups look like: "California and Arizona\nJan 31 – Feb 7\n5 bookings"
 */
async function extractRawCards(page: Page): Promise<Array<{ rawText: string; detailUrl: string }>> {
  await page.waitForSelector(SELECTORS.tripsContent, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1_500);

  return page.evaluate(() => {
    // Strategy 1: find clickable trip group cards via anchor links
    const anchors = Array.from(
      document.querySelectorAll('a[href*="mytrips"], a[href*="mybooking"], a[href*="booking_id"]')
    ).filter((a) => {
      const href = (a as HTMLAnchorElement).href;
      return href.includes("booking.com") && !href.includes("/search") && !href.includes("mytrips.html");
    }) as HTMLAnchorElement[];

    if (anchors.length > 0) {
      const seen = new Set<string>();
      const results: Array<{ rawText: string; detailUrl: string }> = [];
      anchors.forEach((anchor) => {
        if (seen.has(anchor.href)) return;
        seen.add(anchor.href);
        let el: HTMLElement = anchor;
        for (let i = 0; i < 8 && el.parentElement; i++) {
          el = el.parentElement as HTMLElement;
          if (el.offsetHeight > 80 && el.offsetWidth > 150) break;
        }
        results.push({ rawText: el.innerText.trim(), detailUrl: anchor.href });
      });
      if (results.length > 0) return results;
    }

    // Strategy 2: full page innerText — Booking.com renders trip groups as text blocks
    // The LLM will parse the text to understand the structure
    const main = document.querySelector('main, [role="main"], #bodyconstraint-inner') as HTMLElement | null;
    const rawText = (main ?? document.body).innerText.trim();
    return rawText.length > 50 ? [{ rawText, detailUrl: "" }] : [];
  });
}

/**
 * Parse a raw card text block into a structured Booking object.
 * All fields are best-effort — rawText is always included for LLM fallback.
 */
function parseCard(rawText: string, detailUrl: string, status: TripStatus): Booking {
  const checkIn = extractDateNear(rawText, "check-in") || extractDateNear(rawText, "arrival");
  const checkOut = extractDateNear(rawText, "check-out") || extractDateNear(rawText, "departure");

  // Property name is often on the first non-empty line
  const firstLine = rawText.split("\n").find((l) => l.trim().length > 3)?.trim() ?? "";

  // Location: look for a line that looks like "City, Country"
  const locationMatch = rawText.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/);

  return {
    confirmationNumber: extractConfirmationNumber(rawText),
    propertyName: firstLine,
    location: locationMatch?.[0] ?? "",
    checkIn,
    checkOut,
    nights: countNights(checkIn, checkOut),
    totalPrice: extractPrice(rawText),
    status,
    detailUrl,
    rawText,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Navigate to the trips list page for a given status and extract all bookings.
 * Each booking includes both structured fields (best-effort) and rawText
 * (full card content) for LLM parsing.
 */
export async function extractTripsPage(
  page: Page,
  status: TripStatus
): Promise<Booking[]> {
  // Navigate via click from www.booking.com — direct goto on secure.booking.com
  // causes ERR_TOO_MANY_REDIRECTS regardless of ?sid= params
  await navigateToTripsPage(page, status);

  const cards = await extractRawCards(page);
  return cards
    .map((c) => parseCard(c.rawText, c.detailUrl, status))
    .filter((b) => b.rawText.length > 20);
}

/**
 * Navigate to a booking detail URL and extract full details.
 * The detailUrl comes from the `detailUrl` field of a Booking returned by extractTripsPage.
 *
 * NOTE: If detailUrl is empty (anchor detection fallback), this function will
 * return a partial BookingDetail based on the trips list content only.
 */
export async function extractBookingDetail(
  page: Page,
  detailUrl: string,
  baseBooking: Booking
): Promise<BookingDetail> {
  if (!detailUrl) {
    // No direct URL — return what we have from the list
    return {
      ...baseBooking,
      propertyAddress: "",
      checkInTime: "",
      checkOutTime: "",
      contactPhone: "",
      specialRequests: "",
      cancellationPolicy: "",
      paymentSummary: "",
    };
  }

  await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector(SELECTORS.tripsContent, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1_500);

  const rawText = await page.evaluate(() => {
    const main = document.querySelector(
      'main, [role="main"], #bodyconstraint-inner'
    ) as HTMLElement | null;
    return (main ?? document.body).innerText.trim();
  });

  // Best-effort extraction from the detail page rawText
  const checkInTime =
    rawText.match(/check-in[^:]*from\s+([\d:]+)/i)?.[1] ??
    rawText.match(/check-in[^:]*:\s*([^\n]+)/i)?.[1]?.trim() ?? "";
  const checkOutTime =
    rawText.match(/check-out[^:]*until\s+([\d:]+)/i)?.[1] ??
    rawText.match(/check-out[^:]*:\s*([^\n]+)/i)?.[1]?.trim() ?? "";
  const contactPhone = rawText.match(/(?:tel|phone|call)[^\d]*(\+?[\d\s\-()]{7,20})/i)?.[1]?.trim() ?? "";
  const cancellationPolicy = rawText.match(/cancellation[^\n]{0,200}/i)?.[0]?.trim() ?? "";
  const paymentSummary = rawText.match(/(?:total paid|payment)[^\n]{0,200}/i)?.[0]?.trim() ?? "";
  const specialRequests = rawText.match(/special request[s]?[^\n]{0,300}/i)?.[0]?.trim() ?? "";
  const propertyAddress = rawText.match(/(?:\d+\s+\w+\s+(?:street|road|avenue|lane|drive|blvd|st|rd|ave)[^\n]*)/i)?.[0]?.trim() ?? "";

  // Merge with base booking fields, prefer detail page data where better
  const checkIn = extractDateNear(rawText, "check-in") || baseBooking.checkIn;
  const checkOut = extractDateNear(rawText, "check-out") || baseBooking.checkOut;

  return {
    ...baseBooking,
    checkIn,
    checkOut,
    nights: countNights(checkIn, checkOut) || baseBooking.nights,
    totalPrice: extractPrice(rawText) || baseBooking.totalPrice,
    rawText,
    propertyAddress,
    checkInTime,
    checkOutTime,
    contactPhone,
    specialRequests,
    cancellationPolicy,
    paymentSummary,
  };
}
