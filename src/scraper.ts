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

