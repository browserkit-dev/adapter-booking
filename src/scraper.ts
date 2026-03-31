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

  // Dismiss the "Don't forget to use your rewards" promo modal that appears
  // on confirmation pages — it covers the page content and pollutes rawText.
  await page.evaluate(() => {
    const dismiss = document.querySelector(
      '[data-dismiss="modal"], ' +
      'button[aria-label*="close" i], ' +
      'button[aria-label*="dismiss" i], ' +
      '[class*="modal"] [class*="close"], ' +
      '[class*="modal"] button, ' +
      'a[data-modal-action="close"]'
    ) as HTMLElement | null;
    dismiss?.click();
  }).catch(() => {});
  await page.waitForTimeout(500);

  const rawText = await page.evaluate(() => {
    const main = document.querySelector(
      'main, [role="main"], #bodyconstraint-inner'
    ) as HTMLElement | null;
    return (main ?? document.body).innerText.trim();
  });

  // ── Confirmation page specific extractions ──────────────────────────────────
  // The confirmation page uses labeled format: "Check-in\nSat, Mar 28, 2026"
  // and "Check-out\nWed, Apr 1, 2026" — different from the trips list.

  // Confirmation number: "6683989891" shown near top or as "Booking number: XXXX"
  const confirmationNumber =
    rawText.match(/(?:booking number|confirmation|pin)[\s:]*(\d{7,12})/i)?.[1]?.trim() ||
    rawText.match(/\b(\d{8,12})\b/)?.[1]?.trim() ||
    baseBooking.confirmationNumber;

  // Property name: on confirmation page, hotel name appears after the confirmation
  // info block, just before "Check-in" — look for it in the lines before "Check-in"
  const propertyName = (() => {
    const lines = rawText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const checkInIdx = lines.findIndex(l => /^check.in$/i.test(l));
    if (checkInIdx > 0) {
      // Hotel name is typically the last non-trivial line before "Check-in"
      for (let i = checkInIdx - 1; i >= 0; i--) {
        const l = lines[i]!;
        if (l.length > 4 && l.length < 100 &&
          !/^(Confirmed|Change|Message|Special|Approximate|Stay safe|You paid|Report|We'll|Learn|Print|Save|Download|Arrival)/i.test(l)) {
          return l;
        }
      }
    }
    // Fallback: first line after "Your booking in X is confirmed"
    const confirmedIdx = lines.findIndex(l => /Your booking.*confirmed/i.test(l));
    if (confirmedIdx >= 0) {
      for (let i = confirmedIdx + 1; i < lines.length; i++) {
        const l = lines[i]!;
        if (l.length > 4 && l.length < 100 && !/^(You|We|Get|Save|Print|Stay|To |Report|Learn|Booking\.com)/i.test(l)) {
          return l;
        }
      }
    }
    return baseBooking.propertyName;
  })();

  // Dates — confirmation page format: "Check-in\nSat, Mar 28, 2026"
  // Also try: "2026-03-28" ISO format in the text
  const checkInRaw =
    rawText.match(/check.in\s*\n+\w+,?\s*(\w+ \d+,?\s*\d{4})/i)?.[1]?.trim() ||
    rawText.match(/check.in[^\n]*\n+([^\n]{5,30})/i)?.[1]?.trim() || "";
  const checkOutRaw =
    rawText.match(/check.out\s*\n+\w+,?\s*(\w+ \d+,?\s*\d{4})/i)?.[1]?.trim() ||
    rawText.match(/check.out[^\n]*\n+([^\n]{5,30})/i)?.[1]?.trim() || "";

  const checkIn = extractDateNear(rawText, "check-in") || checkInRaw || baseBooking.checkIn;
  const checkOut = extractDateNear(rawText, "check-out") || checkOutRaw || baseBooking.checkOut;

  // Times: on confirmation page, time appears on the line AFTER the date
  // Pattern: "Check-in\nSat, Mar 28, 2026\n16:00 - 19:00"
  const checkInTime = (() => {
    const m = rawText.match(/check.in\s*\n[^\n]+\n\s*([\d:]+\s*[-–]\s*[\d:]+|[\d:]+(?:\s*(?:AM|PM))?)/i);
    if (m?.[1]) return m[1].trim();
    return rawText.match(/(?:check.in from|arrive from|check-in time)[^\d]*([\d:][\d: -]+)/i)?.[1]?.trim() ?? "";
  })();
  const checkOutTime = (() => {
    const m = rawText.match(/check.out\s*\n[^\n]+\n\s*([\d:]+\s*[-–]\s*[\d:]+|[\d:]+(?:\s*(?:AM|PM))?)/i);
    if (m?.[1]) return m[1].trim();
    return rawText.match(/(?:check.out (?:until|before|by)|check-out time|until)[^\d]*([\d:][\d: -]+)/i)?.[1]?.trim() ?? "";
  })();

  // Contact phone
  const contactPhone = rawText.match(/(?:tel|phone|call)[^\d]*(\+?[\d\s\-().]{7,20})/i)?.[1]?.trim() ?? "";

  // Cancellation policy — grab the line/section after "Cancellation" heading
  const cancellationPolicy =
    rawText.match(/(?:free cancellation[^\n]*|non-refundable[^\n]*|cancellation policy[^\n]{0,200})/i)?.[0]?.trim() ?? "";

  // Payment summary
  const paymentSummary =
    rawText.match(/(?:total paid|amount paid|payment)[^\n]{0,200}/i)?.[0]?.trim() ?? "";

  // Special requests
  const specialRequests = rawText.match(/special request[s]?[^\n]{0,300}/i)?.[0]?.trim() ?? "";

  // Property address — look for numbered street address
  const propertyAddress =
    rawText.match(/\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|Road|Avenue|Lane|Drive|Blvd|St|Rd|Ave|Way|Piazza|Rue|Straat|Strasse)[^\n]*/i)?.[0]?.trim() ?? "";

  return {
    ...baseBooking,
    confirmationNumber,
    propertyName,
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

// ── Reviews types ─────────────────────────────────────────────────────────────

export type ReviewSort =
  | "most_relevant"
  | "newest_first"
  | "oldest_first"
  | "highest_scores"
  | "lowest_scores";

export interface PropertyReview {
  /** Reviewer display name */
  reviewer: string;
  /** Reviewer nationality, e.g. "France" */
  country: string;
  /** Review score, e.g. 9.2 */
  score: number | null;
  /** Review date as displayed, e.g. "Reviewed: March 29, 2026" */
  date: string;
  /** Bold review headline, e.g. "Exceptional" */
  title: string;
  /** Positive body text */
  pros: string;
  /** Negative body text (may be empty) */
  cons: string;
  /** Room type booked, e.g. "Family Suite" */
  roomType: string;
  /** Stay duration string, e.g. "2 nights · March 2026" */
  stayDuration: string;
  /** Traveller type, e.g. "Couple" */
  travellerType: string;
  /** Full card innerText — LLM fallback */
  rawText: string;
}

// ── Phase 2: Search & Property types ─────────────────────────────────────────

export interface SearchResult {
  /** Hotel/property name */
  name: string;
  /** Score + label, e.g. "8.5 Excellent" */
  rating: string;
  /** Number of reviews, e.g. "1,234 reviews" */
  reviewCount: string;
  /** Neighbourhood + distance, e.g. "City Centre · 0.3km" */
  location: string;
  /** Price per night as displayed */
  pricePerNight: string;
  /** Total price for the stay */
  totalPrice: string;
  /** Full URL to the property page — pass to get_property or get_availability */
  propertyUrl: string;
  /** Full card innerText for LLM fallback parsing */
  rawText: string;
}

export interface PropertyDetail {
  /** Hotel/property name */
  name: string;
  /** Score + label */
  rating: string;
  /** Address or neighbourhood */
  location: string;
  /** Property description */
  description: string;
  /** Amenities section text */
  amenities: string;
  /** Review summary text */
  reviewSummary: string;
  /** Room options text (populated when checkin/checkout provided) */
  roomOptions: string;
  /** Full page innerText for LLM parsing */
  rawText: string;
}

// ── Phase 2: Search results extraction ───────────────────────────────────────

/** Candidate selectors for property cards — checked in order, first match wins */
const PROPERTY_CARD_SELECTORS = [
  '[data-testid="property-card"]',
  '[data-testid="property-card-container"]',
  ".sr_item",
  '[data-component="property-card"]',
  "div[data-hotelid]",
] as const;

/** Candidate selectors to wait for before reading search page innerText */
const SEARCH_READY_SELECTORS = [
  '[data-testid="property-card"]',
  ".sr_item",
  '[data-testid="no-results"]',
  "h1",  // fallback — at minimum a heading will appear
] as const;

/**
 * Extract hotel search results from www.booking.com/searchresults.html.
 * Waits for results to render (JS-driven SPA), then extracts either structured
 * card data or falls back to full-page innerText for LLM parsing.
 */
export async function extractSearchResults(page: Page, count: number): Promise<SearchResult[]> {
  // Wait for some property card selector to appear
  let cardSelector = "";
  for (const sel of SEARCH_READY_SELECTORS) {
    const found = await page.locator(sel).count().catch(() => 0);
    if (found > 0) { cardSelector = sel; break; }
  }
  if (!cardSelector) {
    await page.waitForTimeout(3_000); // extra wait for slower renders
  }

  const rawPage = await page.evaluate((sels: readonly string[]) => {
    // Try each card selector to find property cards
    for (const sel of sels) {
      const cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 0) {
        return {
          method: "cards",
          items: cards.map((card) => {
            const el = card as HTMLElement;
            // Extract property link URL from the card
            const anchor = el.querySelector("a[href*='/hotel/']") as HTMLAnchorElement | null;
            return { rawText: el.innerText.trim(), propertyUrl: anchor?.href ?? "" };
          }),
        };
      }
    }
    // Fallback: full page text
    const main = document.querySelector("main, #bodyconstraint-inner") as HTMLElement | null;
    return {
      method: "fullpage",
      items: [{ rawText: (main ?? document.body).innerText.trim(), propertyUrl: "" }],
    };
  }, PROPERTY_CARD_SELECTORS);

  if (rawPage.method === "fullpage" || rawPage.items.length === 0) {
    // Return as a single result block — LLM parses it
    const text = rawPage.items[0]?.rawText ?? "";
    return text.length > 50
      ? [{ name: "", rating: "", reviewCount: "", location: "", pricePerNight: "", totalPrice: "", propertyUrl: "", rawText: text }]
      : [];
  }

  return rawPage.items.slice(0, count).map(({ rawText, propertyUrl }): SearchResult => ({
    name: extractFirstMeaningfulLine(rawText),
    rating: extractRatingFromText(rawText),
    reviewCount: rawText.match(/(\d[\d,]+)\s+review/i)?.[1] ?? "",
    location: extractLocationFromCard(rawText),
    pricePerNight: extractPrice(rawText),
    totalPrice: rawText.match(/(?:total|for \d+ night)[^\n]*([€£$¥][\d,. ]+|[\d,. ]+[€£$¥])/i)?.[0]?.trim() ?? "",
    propertyUrl,
    rawText,
  }));
}

/** Extract first non-empty line that looks like a property name (not a label/tag) */
function extractFirstMeaningfulLine(text: string): string {
  return text.split("\n").find((l) => {
    const t = l.trim();
    return t.length > 3 && t.length < 100 && !/^\d/.test(t) && !/^(New|Deal|Genius|Breakfast)/i.test(t);
  })?.trim() ?? "";
}

function extractRatingFromText(text: string): string {
  const match = text.match(/\b(\d\.\d|\d+)\s*(Exceptional|Superb|Fabulous|Very good|Good|Pleasant|Fair|Okay|Poor)\b/i);
  return match ? `${match[1]} ${match[2]}` : "";
}

function extractLocationFromCard(text: string): string {
  // Look for "X km from centre" or "City Centre" style
  const match = text.match(/(?:[A-Z][a-z]+(?: [A-Z][a-z]+)*\s*·[^\n]+|[\d.]+ km? from [^\n]+)/i);
  return match?.[0]?.trim() ?? "";
}

// ── Phase 2: Property page extraction ────────────────────────────────────────

/** Candidate selectors for property name heading */
const PROPERTY_NAME_SELECTORS = [
  '[data-testid="property-name"]',
  "h2.pp-header__title",
  '[id="hp_hotel_name"]',
  "h1",
] as const;

/**
 * Extract full property details from www.booking.com/hotel/{country}/{slug}.html.
 * Works with or without date parameters — include dates for room/price data.
 */
export async function extractPropertyPage(page: Page): Promise<PropertyDetail> {
  // Wait for property name heading
  for (const sel of PROPERTY_NAME_SELECTORS) {
    const found = await page.locator(sel).count().catch(() => 0);
    if (found > 0) {
      await page.waitForSelector(sel, { timeout: 10_000 }).catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(1_500);

  return page.evaluate((nameSels: readonly string[]) => {
    const main = document.querySelector(
      "main, #bodyconstraint-inner, .bui-page__content"
    ) as HTMLElement | null;
    const fullText = (main ?? document.body).innerText.trim();

    // Extract property name from heading
    let name = "";
    for (const sel of nameSels) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el?.innerText) { name = el.innerText.trim(); break; }
    }

    // Rating: "9.2 Exceptional" or similar — ensure score is a decimal score, not a year
    const ratingMatch = fullText.match(/\b(\d\.\d|\d+)\s*(Exceptional|Superb|Fabulous|Very good|Good|Pleasant|Fair|Okay|Poor)\b/i);
    const rating = ratingMatch ? `${ratingMatch[1]} ${ratingMatch[2]}` : "";

    // Location — first line containing "," that looks like an address
    const locationMatch = fullText.match(/[A-Z][a-z]+(?: [A-Z][a-z]+)*,\s*[A-Z][a-z]+/);
    const location = locationMatch?.[0] ?? "";

    // Amenities section: look for block between "Facilities" or "Amenities" heading
    const amenitiesMatch = fullText.match(/(?:Most popular facilities|Facilities|Amenities)[^\n]*([\s\S]{0,600})/i);
    const amenities = amenitiesMatch?.[1]?.trim().slice(0, 400) ?? "";

    // Reviews section
    const reviewMatch = fullText.match(/(?:Guest reviews|What guests say)[^\n]*([\s\S]{0,400})/i);
    const reviewSummary = reviewMatch?.[1]?.trim().slice(0, 300) ?? "";

    // Room options — look for "Select rooms" or table section
    const roomMatch = fullText.match(/(?:Select rooms|Room options|Available rooms)[^\n]*([\s\S]{0,800})/i);
    const roomOptions = roomMatch?.[1]?.trim().slice(0, 600) ?? "";

    // Description — often after the property name, before amenities
    const descMatch = fullText.match(/(?:About this property|Property description|Overview)[^\n]*([\s\S]{0,500})/i);
    const description = descMatch?.[1]?.trim().slice(0, 400) ?? "";

    return { name, rating, location, description, amenities, reviewSummary, roomOptions, rawText: fullText.slice(0, 3000) };
  }, PROPERTY_NAME_SELECTORS);
}

// ── Saved properties (wishlist) ───────────────────────────────────────────────

export interface SavedProperty {
  /** Hotel/property name */
  name: string;
  /** City, Country */
  location: string;
  /** Review score, e.g. 9.5 */
  rating: number | null;
  /** Total review count */
  reviewCount: number;
  /** Stars */
  stars: number | null;
  /** Price per stay (if available for wishlist dates) */
  price: string;
  /** Price currency */
  currency: string;
  /** Whether sold out for wishlist dates */
  isSoldOut: boolean;
  /** Full URL to the property page */
  propertyUrl: string;
  /** Booking.com hotel page name (slug) */
  pageName: string;
  /** Wishlist ID this property belongs to */
  wishlistId: string;
  /** Wishlist name */
  wishlistName: string;
}

/**
 * Booking.com wishlist GraphQL queries — discovered from HAR analysis.
 *
 * The wishlist feature uses GraphQL at /dml/graphql with two operations:
 * 1. wishlistsDetailForWishlistWidget — lists all wishlists with their IDs
 * 2. userWishlistById — gets hotels in a specific wishlist
 *
 * These are called via page.evaluate() + fetch() so they share the browser's
 * session cookies (including sid, Cloudflare clearance) automatically.
 */
const WISHLIST_LIST_QUERY = `
query wishlistsDetailForWishlistWidget {
  wishlistService {
    userWishlist {
      ... on WishlistMultipleSuccessOutput {
        wishlists {
          listId
          nbHotels
          nbAttractions
          headerImageUrl
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}
`;

const WISHLIST_HOTELS_QUERY = `
query userWishlistById($input: UserWishlistInput) {
  wishlistService {
    userWishlistById(input: $input) {
      ... on WishlistSuccessOutput {
        wishlist {
          listId
          name
          nbHotels
          lastAdded
          accommodationVerticalConfig {
            checkin
            checkout
            numRooms
            numAdults
            __typename
          }
          hotels {
            hotelId
            checkin
            checkout
            details {
              displayName
              pageName
              id
              location {
                displayLocation
                countryCode
                mainDistance
                __typename
              }
              reviews {
                totalScore
                reviewsCount
                __typename
              }
              starRating {
                value
                __typename
              }
              availabilityData {
                isSoldOut
                priceDisplayInfo {
                  displayPrice {
                    amountPerStay {
                      amountRounded
                      currency
                      __typename
                    }
                    __typename
                  }
                  __typename
                }
                __typename
              }
              photos {
                highResUrl {
                  relativeUrl
                  __typename
                }
                __typename
              }
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      ... on WishlistFailResult {
        message
        __typename
      }
      __typename
    }
    __typename
  }
}
`;

interface WishlistGraphQLResponse {
  data: {
    wishlistService: {
      userWishlist?: {
        wishlists?: Array<{
          listId: number;
          nbHotels: number;
        }>;
      };
      userWishlistById?: {
        wishlist?: {
          listId: number;
          name: string | null;
          nbHotels: number;
          accommodationVerticalConfig?: {
            checkin: string;
            checkout: string;
          };
          hotels: Array<{
            hotelId: number;
            checkin: string;
            checkout: string;
            details: {
              displayName: string;
              pageName: string;
              id: number;
              location: {
                displayLocation: string;
                countryCode: string;
                mainDistance: string;
              };
              reviews: { totalScore: number; reviewsCount: number };
              starRating: { value: number } | null;
              availabilityData: {
                isSoldOut: boolean;
                priceDisplayInfo?: {
                  displayPrice?: {
                    amountPerStay?: { amountRounded: string; currency: string };
                  };
                };
              };
            };
          }>;
        };
      };
    };
  };
}

/**
 * Call Booking.com's internal GraphQL API from within the browser context.
 * The browser's cookies (sid, Cloudflare clearance, etc.) are auto-included.
 *
 * Required headers are extracted from the page context — Booking.com injects
 * the CSRF token and other values into the window/DOM when mywishlist.html loads.
 */
async function callGraphQL<T>(page: Page, query: string, variables?: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    async ({ q, vars }: { q: string; vars?: Record<string, unknown> }) => {
      // Extract URL params (label, sid, aid) from current page URL
      const url = new URL(window.location.href);
      const label = url.searchParams.get("label") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      const aid = url.searchParams.get("aid") ?? "304142";

      // Build query string
      const params = new URLSearchParams({ aid });
      if (label) params.set("label", label);
      if (sid) params.set("sid", sid);

      // Extract CSRF token — Booking.com injects it in several places
      const csrfMeta = (
        document.querySelector('meta[name="x-booking-csrf-token"]') ||
        document.querySelector('meta[name="csrf-token"]')
      ) as HTMLMetaElement | null;

      // Also check window globals (Booking.com's SPA framework stores it here)
      type BookingWindow = Window & {
        __CSRF_TOKEN__?: string;
        booking?: { csrf?: string };
        b_csrf_token?: string;
      };
      const win = window as BookingWindow;
      const csrfToken =
        csrfMeta?.content ||
        win.__CSRF_TOKEN__ ||
        win.booking?.csrf ||
        win.b_csrf_token ||
        "";

      // pageview ID — Booking.com tracks this per page load
      type BookingPageView = Window & {
        booking_data?: { pageview_id?: string };
        b_pageview_id?: string;
      };
      const pwin = window as BookingPageView;
      const pageviewId =
        pwin.booking_data?.pageview_id ||
        pwin.b_pageview_id ||
        `${Date.now()}`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "*/*",
        "apollographql-client-name": "b-wishlist-wishlist-mfe",
        "x-booking-context-action": "mywishlist",
        "x-booking-context-action-name": "mywishlist",
        "x-booking-context-aid": aid,
        "x-booking-site-type-id": "1",
        "x-booking-topic": "capla_browser_b-wishlist-wishlist-mfe",
        "x-booking-pageview-id": pageviewId,
      };
      if (csrfToken) headers["x-booking-csrf-token"] = csrfToken;

      try {
        const resp = await fetch(`/dml/graphql?${params.toString()}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ query: q, variables: vars }),
          credentials: "include",
        });
        if (!resp.ok) {
          return { error: `HTTP ${resp.status}`, data: null };
        }
        return resp.json();
      } catch (err) {
        return { error: String(err), data: null };
      }
    },
    { q: query, vars: variables }
  ) as Promise<T>;
}

/**
 * Extract saved/wishlisted properties using Booking.com's internal GraphQL API.
 *
 * The page must already be on www.booking.com for the GraphQL call to work
 * (same-origin fetch + cookies). Navigates to mywishlist.html first to ensure
 * the wishlist page context is loaded.
 *
 * Returns all hotels across all wishlists, up to `count`.
 */
export async function extractSavedProperties(page: Page, count: number): Promise<SavedProperty[]> {
  // Intercept the GraphQL responses that the page naturally makes when loading mywishlist.html.
  // The page calls wishlistsDetailForWishlistWidget + userWishlistById automatically.
  // We capture those responses instead of trying to replay the API call ourselves
  // (which fails due to CSRF token complexity).

  const capturedWishlists: WishlistGraphQLResponse["data"]["wishlistService"]["userWishlist"] = undefined as never;
  const capturedListDetails = new Map<string, NonNullable<WishlistGraphQLResponse["data"]["wishlistService"]["userWishlistById"]>>();
  void capturedListDetails; // unused — interceptedData.listDetails used instead

  const interceptedData: {
    wishlists?: Array<{ listId: number; nbHotels: number }>;
    listDetails: Map<string, { hotels: Array<{
      displayName: string; pageName: string;
      location: { displayLocation: string; countryCode: string };
      reviews: { totalScore: number; reviewsCount: number };
      starRating?: { value: number } | null;
      availabilityData?: { isSoldOut: boolean; priceDisplayInfo?: { displayPrice?: { amountPerStay?: { amountRounded: string; currency: string } } } };
    }>; name: string | null; listId: number }>;
  } = { listDetails: new Map() };

  // Set up response interceptor BEFORE navigation
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/dml/graphql")) return;
    try {
      const body = await response.json() as WishlistGraphQLResponse;
      if (!body?.data?.wishlistService) return;

      // Capture wishlists list
      const userWishlist = body.data.wishlistService.userWishlist;
      if (userWishlist?.wishlists && userWishlist.wishlists.length > 0) {
        interceptedData.wishlists = userWishlist.wishlists;
      }

      // Capture individual wishlist details
      const wishlistById = body.data.wishlistService.userWishlistById;
      if (wishlistById?.wishlist) {
        const wl = wishlistById.wishlist;
        const listId = String(wl.listId ?? "");
        if (listId && wl.hotels) {
          interceptedData.listDetails.set(listId, {
            listId: wl.listId ?? 0,
            name: wl.name,
            hotels: (wl.hotels ?? []).map((h) => {
              const d = h.details;
              return {
                displayName: d.displayName,
                pageName: d.pageName,
                location: d.location,
                reviews: d.reviews,
                starRating: d.starRating,
                availabilityData: d.availabilityData,
              };
            }),
          });
        }
      }
    } catch { /* ignore parse errors */ }
  });

  // Navigate — this triggers the natural GraphQL calls
  await page.goto("https://www.booking.com/mywishlist.html", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await page.waitForTimeout(3_500); // wait for API calls to complete

  // If we captured GraphQL data, use it (best quality)
  if (interceptedData.listDetails.size > 0) {
    const results: SavedProperty[] = [];

    for (const [listId, wl] of interceptedData.listDetails) {
      if (results.length >= count) break;
      const wishlistName = wl.name ?? `Wishlist ${listId}`;

      for (const d of wl.hotels) {
        if (results.length >= count) break;
        const priceInfo = d.availabilityData?.priceDisplayInfo?.displayPrice?.amountPerStay;

        results.push({
          name: d.displayName,
          location: `${d.location?.displayLocation ?? ""}, ${(d.location?.countryCode ?? "").toUpperCase()}`,
          rating: d.reviews?.totalScore ?? null,
          reviewCount: d.reviews?.reviewsCount ?? 0,
          stars: d.starRating?.value ?? null,
          price: priceInfo?.amountRounded ?? "",
          currency: priceInfo?.currency ?? "",
          isSoldOut: d.availabilityData?.isSoldOut ?? false,
          propertyUrl: `https://www.booking.com/hotel/${d.location?.countryCode ?? "xx"}/${d.pageName}.html`,
          pageName: d.pageName,
          wishlistId: listId,
          wishlistName,
        });
      }
    }

    // If we have the wishlists list but not all their details, navigate to remaining ones
    if (interceptedData.wishlists && interceptedData.wishlists.length > interceptedData.listDetails.size) {
      for (const wl of interceptedData.wishlists) {
        if (results.length >= count) break;
        if (wl.nbHotels === 0) continue;
        if (interceptedData.listDetails.has(String(wl.listId))) continue;

        // Navigate to this specific wishlist to trigger its GraphQL load
        await page.goto(`https://www.booking.com/mywishlist.html?wl_id=${wl.listId}`, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        await page.waitForTimeout(2_500);

        const freshData = interceptedData.listDetails.get(String(wl.listId));
        if (freshData) {
          const wishlistName = freshData.name ?? `Wishlist ${wl.listId}`;
          for (const d of freshData.hotels) {
            if (results.length >= count) break;
            const priceInfo = d.availabilityData?.priceDisplayInfo?.displayPrice?.amountPerStay;
            results.push({
              name: d.displayName,
              location: `${d.location?.displayLocation ?? ""}, ${(d.location?.countryCode ?? "").toUpperCase()}`,
              rating: d.reviews?.totalScore ?? null,
              reviewCount: d.reviews?.reviewsCount ?? 0,
              stars: d.starRating?.value ?? null,
              price: priceInfo?.amountRounded ?? "",
              currency: priceInfo?.currency ?? "",
              isSoldOut: d.availabilityData?.isSoldOut ?? false,
              propertyUrl: `https://www.booking.com/hotel/${d.location?.countryCode ?? "xx"}/${d.pageName}.html`,
              pageName: d.pageName,
              wishlistId: String(wl.listId),
              wishlistName,
            });
          }
        }
      }
    }

    if (results.length > 0) return results;
  }

  // Final fallback: DOM extraction from current page
  return extractFromCurrentPage(page, "");
}

// ── Reviews extraction ────────────────────────────────────────────────────────

/** Candidate selectors for individual review cards inside the reviewlist page */
const REVIEW_CARD_SELECTORS = [
  '[data-testid="review-card"]',
  '.review_list_new_item_block',
  '[data-review-id]',
  '.c-review',
] as const;

/**
 * Attempt to extract reviews from a Booking.com API response JSON blob.
 * Supports the REST review gateway and GraphQL shapes.
 */
function extractReviewsFromApiResponse(body: Record<string, unknown>): Array<{
  rawText: string; score: string; title: string; pros: string; cons: string;
  reviewer: string; country: string; date: string; roomType: string; stayDuration: string; travellerType: string;
}> {
  type ApiReview = Record<string, unknown>;
  const results: ReturnType<typeof extractReviewsFromApiResponse> = [];

  // Shape 1: { reviews: [...] } or { data: { reviews: [...] } }
  const reviews: unknown[] =
    (body["reviews"] as unknown[]) ||
    ((body["data"] as Record<string, unknown>)?.["reviews"] as unknown[]) ||
    ((body["result"] as Record<string, unknown>)?.["reviews"] as unknown[]) ||
    [];

  for (const rev of reviews) {
    const r = rev as ApiReview;
    const text = JSON.stringify(r);
    results.push({
      rawText: text.slice(0, 500),
      score: String(r["average_score"] ?? r["score"] ?? r["rating"] ?? ""),
      title: String(r["title"] ?? r["headline"] ?? ""),
      pros: String(r["pros"] ?? r["positive"] ?? r["liked"] ?? ""),
      cons: String(r["cons"] ?? r["negative"] ?? r["disliked"] ?? ""),
      reviewer: String(r["author"] ?? r["reviewer_name"] ?? r["name"] ?? ""),
      country: String(r["author_country"] ?? r["country"] ?? r["nationality"] ?? ""),
      date: String(r["review_date"] ?? r["date"] ?? ""),
      roomType: String(r["room_name"] ?? r["room_type"] ?? ""),
      stayDuration: String(r["stay_duration"] ?? r["nights"] ?? ""),
      travellerType: String(r["traveller_type"] ?? r["group_type"] ?? ""),
    });
  }
  return results;
}

/**
 * Extract guest reviews for a Booking.com property using the dedicated
 * `reviewlist.html` paginated page.
 *
 * This is far simpler and more reliable than trying to control the reviews
 * modal on the property page. The reviewlist URL is:
 *   www.booking.com/reviewlist.html?pagename=X&cc1=Y&type=total&rows=25&offset=N
 *
 * Sort params discovered from the reviewlist page UI:
 *   most_relevant → (no sort param)
 *   newest_first  → sort=f_recent_desc
 *   oldest_first  → sort=f_recent_asc
 *   highest_scores→ sort=f_score_desc
 *   lowest_scores → sort=f_score_asc
 *
 * Returns up to `count` reviews (max 75). Falls back gracefully on error.
 */
export async function extractPropertyReviews(
  page: Page,
  propertyUrl: string,
  count: number,
  sort: ReviewSort
): Promise<PropertyReview[]> {
  // Extract pageName and countryCode from the property URL
  // e.g. https://www.booking.com/hotel/it/il-castelluccio-countryresort.html
  const urlMatch = propertyUrl.match(/\/hotel\/([a-z]{2})\/([^/?#]+?)(?:\.html)?(?:\?|$)/);
  if (!urlMatch) {
    return []; // not a recognisable Booking.com hotel URL
  }
  const [, cc1, pageName] = urlMatch;

  const sortParam: Record<ReviewSort, string> = {
    most_relevant: "",
    newest_first: "f_recent_desc",
    oldest_first: "f_recent_asc",
    highest_scores: "f_score_desc",
    lowest_scores: "f_score_asc",
  };

  const allCards: PropertyReview[] = [];
  const seenKeys = new Set<string>();
  const rowsPerPage = 25;
  let offset = 0;

  while (allCards.length < count) {
    const params = new URLSearchParams({
      pagename: pageName ?? "",
      cc1: cc1 ?? "",
      type: "total",
      rows: String(rowsPerPage),
      offset: String(offset),
      lang: "en-us",
    });
    const sortVal = sortParam[sort];
    if (sortVal) params.set("sort", sortVal);

    const reviewListUrl = `https://www.booking.com/reviewlist.html?${params.toString()}`;
    await page.goto(reviewListUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForTimeout(1_500);

    // Extract review blocks from the page
    const batch = await page.evaluate(
      ({ cardSels }: { cardSels: readonly string[] }) => {
        type RawReview = {
          rawText: string; score: string; title: string; pros: string; cons: string;
          reviewer: string; country: string; date: string;
          roomType: string; stayDuration: string; travellerType: string;
        };

        // Try data-testid card selectors first
        let cards: HTMLElement[] = [];
        for (const sel of cardSels) {
          const found = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
          if (found.length > 0) { cards = found; break; }
        }

        // Fallback: extract from full page innerText by splitting on "Reviewed:" markers
        if (cards.length === 0) {
          const main = document.querySelector("main, #bodyconstraint-inner, .review_list") as HTMLElement | null;
          const fullText = (main ?? document.body).innerText.trim();

          // Split on Reviewed: anchors — each review starts with a reviewer name and ends
          // just before the next reviewer's block
          const blocks = fullText.split(/\n(?=\S.*?\n(?:Suite|Room|Apartment|Studio|Villa|Bungalow|Double|Twin|Single|Triple|Family|Deluxe|Standard|Superior|Classic|Luxury|Junior|Penthouse|Executive|Premiere)\n)/i);

          if (blocks.length <= 1) {
            // Second fallback: split on "Reviewed: " lines as anchors
            const byReviewed = fullText.split(/(?=Reviewed:\s)/i);
            if (byReviewed.length > 1) {
              return byReviewed.slice(1).map((block: string): RawReview => {
                const lines = block.split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 0);
                const dateMatch = lines[0]?.match(/Reviewed:\s*(.+)/i);
                const date = dateMatch?.[1]?.trim() ?? "";
                const title = lines[1] ?? "";
                const score = lines[2]?.match(/\b(10(?:\.0)?|[0-9]\.[0-9])\b/)?.[1] ?? "";
                const prosLine = lines.find((l: string) => /^Liked\s*[·•]/i.test(l));
                const consLine = lines.find((l: string) => /^Disliked\s*[·•]/i.test(l));
                const pros = prosLine ? prosLine.replace(/^Liked\s*[·•\s]*/i, "").trim() : "";
                const cons = consLine ? consLine.replace(/^Disliked\s*[·•\s]*/i, "").trim() : "";
                return {
                  rawText: block.slice(0, 600),
                  score, title, pros, cons,
                  reviewer: "", country: "", date,
                  roomType: "", stayDuration: "", travellerType: "",
                };
              });
            }
          }

          return [];
        }

        // Process found card elements
        const results: RawReview[] = [];
        for (const card of cards) {
          const rawText = card.innerText?.trim() ?? "";
          if (!rawText || rawText.length < 20) continue;

          const scoreMatch = rawText.match(/\b(10(?:\.0)?|[0-9]\.[0-9])\b/);
          const score = scoreMatch?.[1] ?? "";

          const boldEl = card.querySelector("strong, b, h3, h4, [data-testid='review-title']") as HTMLElement | null;
          let title = boldEl?.innerText?.trim() ?? "";
          if (!title) {
            const tm = rawText.match(/\b(Exceptional|Wonderful|Good|Superb|Fabulous|Pleasant|Poor|Okay)\b/);
            title = tm?.[1] ?? "";
          }

          const posEl = card.querySelector('[data-testid="review-positive-text"], [data-testid="review-body-pos"]') as HTMLElement | null;
          const negEl = card.querySelector('[data-testid="review-negative-text"], [data-testid="review-body-neg"]') as HTMLElement | null;
          let pros = posEl?.innerText?.trim() ?? "";
          let cons = negEl?.innerText?.trim() ?? "";

          if (!pros && !cons) {
            const prosLine = rawText.match(/Liked\s*[·•][^\n]*/i)?.[0];
            const consLine = rawText.match(/Disliked\s*[·•][^\n]*/i)?.[0];
            pros = prosLine ? prosLine.replace(/^Liked\s*[·•\s]*/i, "").trim() : "";
            cons = consLine ? consLine.replace(/^Disliked\s*[·•\s]*/i, "").trim() : "";
            if (!pros) {
              pros = rawText.split("\n").filter((l: string) => l.trim().length > 20).slice(0, 3).join(" ").slice(0, 400);
            }
          }

          const avatarEl = card.querySelector('[data-testid="review-author"], [class*="bui-avatar-block__title"]') as HTMLElement | null;
          const countryEl = card.querySelector('[data-testid="review-country"], [class*="bui-avatar-block__subtitle"]') as HTMLElement | null;
          let reviewer = avatarEl?.innerText?.trim() ?? "";
          let country = countryEl?.innerText?.trim().replace(/[\u{1F000}-\u{1FFFF}]/gu, "").trim() ?? "";
          if (!reviewer) {
            const nameLines = rawText.split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 1 && l.length < 40);
            reviewer = nameLines[0] ?? "";
            if (!country) country = nameLines[1] ?? "";
          }

          const dateMatch = rawText.match(/reviewed[:\s]+([^\n]+)/i);
          const date = dateMatch?.[1]?.trim() ?? "";

          const metaMatch = rawText.match(/(\d+\s+nights?\s*[·•·]\s*\w+ \d{4})/i);
          const stayDuration = metaMatch?.[1]?.trim() ?? "";

          const roomMatch = rawText.match(/\bsuite\b|\broom\b|\bapartment\b|\bstudio\b|\bvilla\b|\bbungalow\b|\bdouble\b|\btwin\b|\bsingle\b|\bfamily\b/i);
          const roomType = roomMatch
            ? rawText.split("\n").find((l: string) => new RegExp(roomMatch[0], "i").test(l))?.trim() ?? ""
            : "";

          const travellerMatch = rawText.match(/\b(couple|solo traveller|family|group|business traveller)\b/i);
          const travellerType = travellerMatch?.[1]?.trim() ?? "";

          results.push({ rawText, score, title, pros, cons, reviewer, country, date, roomType, stayDuration, travellerType });
        }
        return results;
      },
      { cardSels: REVIEW_CARD_SELECTORS }
    );

    if (batch.length === 0) break; // no more reviews or page error

    for (const raw of batch) {
      const key = raw.rawText.slice(0, 80);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      allCards.push({
        reviewer: raw.reviewer,
        country: raw.country,
        score: raw.score ? parseFloat(raw.score) : null,
        date: raw.date,
        title: raw.title,
        pros: raw.pros,
        cons: raw.cons,
        roomType: raw.roomType,
        stayDuration: raw.stayDuration,
        travellerType: raw.travellerType,
        rawText: raw.rawText,
      });
      if (allCards.length >= count) break;
    }

    if (allCards.length >= count) break;
    offset += rowsPerPage;
  }

  return allCards;
}

/** Extract properties from the currently loaded mywishlist page */
async function extractFromCurrentPage(page: Page, wishlistNameOverride: string): Promise<SavedProperty[]> {
  return page.evaluate((nameOverride: string) => {
    const results: Array<{
      name: string; location: string; rating: number | null; reviewCount: number;
      stars: number | null; price: string; currency: string; isSoldOut: boolean;
      propertyUrl: string; pageName: string; wishlistId: string; wishlistName: string;
    }> = [];

    // Get wishlist name from heading
    const headings = Array.from(document.querySelectorAll("h1, h2, h3")) as HTMLElement[];
    const heading = headings.find(h => h.innerText && h.innerText.trim().length > 1 && h.innerText.trim().length < 80);
    const wishlistName = nameOverride || heading?.innerText?.trim() || "Saved";

    // Get current wl_id from URL
    const urlMatch = window.location.href.match(/wl_id=(\d+)/);
    const wishlistId = urlMatch?.[1] ?? "";

    // Find all property card links
    const anchors = Array.from(document.querySelectorAll("a[href*='/hotel/']")) as HTMLAnchorElement[];
    const seen = new Set<string>();

    for (const anchor of anchors) {
      const href = anchor.href?.split("?")[0] ?? "";
      if (!href || seen.has(href)) continue;

      const cardText = anchor.innerText?.trim();
      if (!cardText || cardText.length < 3) continue;

      seen.add(href);

      // Walk up to card container
      let el: HTMLElement = anchor;
      for (let i = 0; i < 6 && el.parentElement; i++) {
        el = el.parentElement as HTMLElement;
        if (el.offsetHeight > 100) break;
      }

      const rawText = el.innerText?.trim() ?? "";
      const pageMatch = href.match(/\/hotel\/([a-z]{2})\/([^/]+)(?:\.html)?$/);
      const countryCode = pageMatch?.[1] ?? "";
      const pageName = pageMatch?.[2] ?? "";

      const ratingMatch = rawText.match(/\b(8\.\d|9\.\d|10(?:\.0)?)\b/);
      const rating = ratingMatch ? parseFloat(ratingMatch[1] ?? "0") : null;

      const reviewMatch = rawText.match(/(\d[\d,]+)\s+(?:review|Rating)/i);
      const reviewCount = reviewMatch ? parseInt((reviewMatch[1] ?? "0").replace(/,/g, "")) : 0;

      const name = rawText.split("\n").find((l: string) => l.trim().length > 3 && l.trim().length < 100)?.trim() ?? "";

      results.push({
        name, location: countryCode.toUpperCase(), rating, reviewCount,
        stars: null, price: "", currency: "", isSoldOut: false,
        propertyUrl: href, pageName, wishlistId, wishlistName,
      });
    }

    return results;
  }, wishlistNameOverride);
}

