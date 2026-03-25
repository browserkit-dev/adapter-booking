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

// ── URL builder ───────────────────────────────────────────────────────────────

const BASE_URL = "https://secure.booking.com";

/**
 * Build the trips list URL for a given status.
 * Booking.com uses ?status= query param to filter upcoming/past/cancelled.
 * Fallback: mytrips.html without status shows upcoming by default.
 */
export function tripsUrl(status: TripStatus): string {
  return `${BASE_URL}/mytrips.html?status=${status}`;
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

// ── Page extraction ───────────────────────────────────────────────────────────

/**
 * Wait for the trips page to load and extract all booking links + raw text.
 * Returns an array of { rawText, detailUrl } per booking card found.
 */
async function extractRawCards(page: Page): Promise<Array<{ rawText: string; detailUrl: string }>> {
  // Wait for main content to appear
  await page.waitForSelector(SELECTORS.tripsContent, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1_500); // allow React render to settle

  return page.evaluate(() => {
    // Find all "View booking" / "View details" links — each one is a booking card entry
    const detailAnchors = Array.from(
      document.querySelectorAll('a[href*="mybooking"], a[href*="myreservations"], a[href*="reservation"]')
    ).filter((a) => {
      const href = (a as HTMLAnchorElement).href;
      // Must be an actual booking detail link, not navigation
      return href.includes("booking.com") && !href.includes("/search") && !href.includes("/flights");
    }) as HTMLAnchorElement[];

    if (detailAnchors.length > 0) {
      return detailAnchors.map((anchor) => {
        // Walk up to find the booking card container
        let el: HTMLElement = anchor;
        for (let i = 0; i < 10 && el.parentElement; i++) {
          el = el.parentElement as HTMLElement;
          // Stop when the element is large enough to be a card
          if (el.offsetHeight > 100 && el.offsetWidth > 200) break;
        }
        return {
          rawText: el.innerText.trim(),
          detailUrl: anchor.href,
        };
      });
    }

    // Fallback: extract the full main content as one block when no anchor-based
    // card detection works (e.g. SPA not yet rendered or different DOM structure)
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
  await page.goto(tripsUrl(status), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

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
