import { defineAdapter } from "@browserkit/core";
import { z } from "zod";
import type { Page } from "patchright";
import { SELECTORS } from "./selectors.js";
import { extractTripsPage, extractBookingDetail } from "./scraper.js";

// ── Schemas ───────────────────────────────────────────────────────────────────

const countSchema = z.object({
  count: z.number().int().min(1).max(50).default(10).describe("Max number of bookings to return (1–50)"),
});

const detailSchema = z.object({
  confirmation_number: z
    .string()
    .min(1)
    .describe("Booking confirmation number. Get this from get_upcoming_bookings or get_past_bookings."),
});

// ── Adapter ───────────────────────────────────────────────────────────────────

export default defineAdapter({
  site: "booking",
  domain: "booking.com",
  // loginUrl is where the framework navigates when page is about:blank
  // secure.booking.com/mytrips.html redirects to login if not authenticated
  loginUrl: "https://secure.booking.com/mytrips.html",
  selectors: { accountMenu: SELECTORS.accountMenu },
  rateLimit: { minDelayMs: 3_000 },

  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      const url = page.url();

      // Redirected to login or OAuth flow = not logged in
      if (
        url.includes("/login") ||
        url.includes("account.booking.com/auth") ||
        url.includes("account.booking.com/sign-in")
      ) {
        return false;
      }

      // If there's a login form on the page = not logged in
      const hasLoginForm = await page.locator(SELECTORS.loginForm).count();
      if (hasLoginForm > 0) return false;

      // Must be on the secure domain with content
      const onSecureDomain =
        url.includes("secure.booking.com") || url.includes("account.booking.com");
      if (!onSecureDomain) return false;

      // Verify page has real content (not a blank SPA shell)
      const bodyText = await page
        .evaluate(() => document.body?.innerText?.trim() ?? "")
        .catch(() => "");
      return bodyText.length > 100;
    } catch {
      return false;
    }
  },

  tools: () => [

    // ── get_upcoming_bookings ─────────────────────────────────────────────────
    {
      name: "get_upcoming_bookings",
      description: [
        "Get your upcoming Booking.com reservations.",
        "Returns a list of bookings with property name, location, dates, price, and a detailUrl.",
        "",
        "Each booking includes a rawText field with the full card content for any fields",
        "not captured in the structured output.",
        "",
        "Use get_booking_details with the confirmation_number for full check-in details.",
      ].join("\n"),
      inputSchema: countSchema,
      annotations: { readOnlyHint: true as const },
      async handler(page: Page, input: unknown) {
        const { count } = countSchema.parse(input);
        const bookings = await extractTripsPage(page, "upcoming");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(bookings.slice(0, count), null, 2) }],
        };
      },
    },

    // ── get_past_bookings ─────────────────────────────────────────────────────
    {
      name: "get_past_bookings",
      description: [
        "Get your past Booking.com trips.",
        "Returns a list of completed stays with property name, location, dates, and price.",
        "",
        "Each booking includes a rawText field with the full card content.",
        "Use get_booking_details with the confirmation_number for full details.",
      ].join("\n"),
      inputSchema: countSchema,
      annotations: { readOnlyHint: true as const },
      async handler(page: Page, input: unknown) {
        const { count } = countSchema.parse(input);
        const bookings = await extractTripsPage(page, "past");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(bookings.slice(0, count), null, 2) }],
        };
      },
    },

    // ── get_booking_details ───────────────────────────────────────────────────
    {
      name: "get_booking_details",
      description: [
        "Get full details for a specific Booking.com reservation.",
        "Includes check-in/out times, property address, cancellation policy, payment summary, and special requests.",
        "",
        "First call get_upcoming_bookings or get_past_bookings to find the confirmation_number.",
        "",
        "Returns a BookingDetail object with all available fields plus rawText for LLM parsing.",
      ].join("\n"),
      inputSchema: detailSchema,
      annotations: { readOnlyHint: true as const },
      async handler(page: Page, input: unknown) {
        const { confirmation_number } = detailSchema.parse(input);

        // Search both upcoming and past to find the booking
        let bookings = await extractTripsPage(page, "upcoming");
        let match = bookings.find(
          (b) =>
            b.confirmationNumber === confirmation_number ||
            b.rawText.toLowerCase().includes(confirmation_number.toLowerCase())
        );

        if (!match) {
          bookings = await extractTripsPage(page, "past");
          match = bookings.find(
            (b) =>
              b.confirmationNumber === confirmation_number ||
              b.rawText.toLowerCase().includes(confirmation_number.toLowerCase())
          );
        }

        if (!match) {
          return {
            content: [{
              type: "text" as const,
              text: `Booking with confirmation number "${confirmation_number}" not found. ` +
                "Call get_upcoming_bookings or get_past_bookings to verify the confirmation number.",
            }],
            isError: true,
          };
        }

        const detail = await extractBookingDetail(page, match.detailUrl, match);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }],
        };
      },
    },

  ],
});
