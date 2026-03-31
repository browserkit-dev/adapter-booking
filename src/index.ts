import { defineAdapter } from "@browserkit/core";
import { z } from "zod";
import type { Page } from "patchright";
import { SELECTORS } from "./selectors.js";
import { extractTripsPage, extractBookingDetail, extractSearchResults, extractPropertyPage, extractSavedProperties, extractPropertyReviews, type ReviewSort } from "./scraper.js";

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
  // www.booking.com is the only domain where captured session cookies work.
  // secure.booking.com requires a ?sid= query param that is embedded in the
  // mytrips link on the homepage — see extractTripsPage in scraper.ts.
  loginUrl: "https://www.booking.com",
  selectors: { accountMenu: SELECTORS.accountMenu },
  rateLimit: { minDelayMs: 3_000 },

  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      const url = page.url();

      // Redirected to sign-in = not logged in
      if (url.includes("/sign-in") || url.includes("/login")) return false;

      // Must be on booking.com domain
      if (!url.includes("booking.com")) return false;

      // Primary check: account menu with username — only present when logged in.
      // Confirmed working: shows "Jonathan Zarecki / Genius Level 3" when authenticated.
      const hasAccountMenu = await page.locator(SELECTORS.accountMenu).count();
      if (hasAccountMenu > 0) return true;

      // Fallback: not on a login form
      const hasLoginForm = await page.locator(SELECTORS.loginForm).count();
      if (hasLoginForm > 0) return false;

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

    // ── search_hotels ────────────────────────────────────────────────────────
    {
      name: "search_hotels",
      description: [
        "Search Booking.com for hotels and accommodations.",
        "Works in headless mode — no watch mode required.",
        "",
        "Returns a list of properties with name, rating, location, price, and URL.",
        "Pass propertyUrl to get_property for full details, or get_availability for room prices.",
        "",
        "Examples:",
        "  search_hotels({ destination: 'Amsterdam', checkin: '2026-06-01', checkout: '2026-06-04' })",
        "  search_hotels({ destination: 'Paris', checkin: '2026-07-10', checkout: '2026-07-14', adults: 2, sort: 'price' })",
      ].join("\n"),
      inputSchema: z.object({
        destination: z.string().min(1).describe("City, neighborhood, hotel name, or landmark"),
        checkin: z.string().describe("Check-in date (YYYY-MM-DD)"),
        checkout: z.string().describe("Check-out date (YYYY-MM-DD)"),
        adults: z.number().int().min(1).max(30).default(2).describe("Number of adults"),
        rooms: z.number().int().min(1).max(30).default(1).describe("Number of rooms"),
        count: z.number().int().min(1).max(25).default(10).describe("Max results to return"),
        sort: z.enum(["popularity", "price", "review_score", "distance"]).default("popularity").optional()
          .describe("Sort order: popularity (default), price, review_score, distance"),
      }),
      annotations: { readOnlyHint: true as const, openWorldHint: true as const },
      async handler(page: Page, input: unknown) {
        const { destination, checkin, checkout, adults, rooms, count, sort } = z.object({
          destination: z.string(),
          checkin: z.string(),
          checkout: z.string(),
          adults: z.number().default(2),
          rooms: z.number().default(1),
          count: z.number().default(10),
          sort: z.enum(["popularity", "price", "review_score", "distance"]).default("popularity").optional(),
        }).parse(input);

        const params = new URLSearchParams({
          ss: destination,
          checkin,
          checkout,
          group_adults: String(adults),
          no_rooms: String(rooms),
          order: sort ?? "popularity",
        });

        const url = `https://www.booking.com/searchresults.html?${params.toString()}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
        await page.waitForTimeout(2_000); // allow React to render results

        const results = await extractSearchResults(page, count);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      },
    },

    // ── get_property ─────────────────────────────────────────────────────────
    {
      name: "get_property",
      description: [
        "Get full details for a Booking.com property: name, rating, location, amenities, and reviews.",
        "Works in headless mode — no watch mode required.",
        "",
        "Use search_hotels first to get a property URL, then pass it here.",
        "Include checkin/checkout to also see room types and prices.",
        "",
        "Returns: { name, rating, location, description, amenities, reviewSummary, roomOptions, rawText }",
        "",
        "Examples:",
        "  get_property({ property_url: 'https://www.booking.com/hotel/nl/...', checkin: '2026-06-01', checkout: '2026-06-04' })",
      ].join("\n"),
      inputSchema: z.object({
        property_url: z.string().url().describe("Full Booking.com hotel URL from search_hotels"),
        checkin: z.string().optional().describe("Check-in date (YYYY-MM-DD) — include for room prices"),
        checkout: z.string().optional().describe("Check-out date (YYYY-MM-DD)"),
        adults: z.number().int().min(1).max(30).default(2).optional().describe("Number of adults"),
      }),
      annotations: { readOnlyHint: true as const, openWorldHint: true as const },
      async handler(page: Page, input: unknown) {
        const { property_url, checkin, checkout, adults } = z.object({
          property_url: z.string().url(),
          checkin: z.string().optional(),
          checkout: z.string().optional(),
          adults: z.number().default(2).optional(),
        }).parse(input);

        let url = property_url;
        if (checkin && checkout) {
          const u = new URL(property_url);
          u.searchParams.set("checkin", checkin);
          u.searchParams.set("checkout", checkout);
          u.searchParams.set("group_adults", String(adults ?? 2));
          url = u.toString();
        }

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
        await page.waitForTimeout(2_000);

        const detail = await extractPropertyPage(page);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }],
        };
      },
    },

    // ── get_availability ─────────────────────────────────────────────────────
    {
      name: "get_availability",
      description: [
        "Get available rooms and prices for a specific Booking.com property on given dates.",
        "Works in headless mode — no watch mode required.",
        "",
        "Use search_hotels to find properties, then this tool for room options and pricing.",
        "",
        "Returns the same shape as get_property but with roomOptions populated.",
        "",
        "Examples:",
        "  get_availability({ property_url: 'https://www.booking.com/hotel/nl/...', checkin: '2026-06-01', checkout: '2026-06-04', adults: 2 })",
      ].join("\n"),
      inputSchema: z.object({
        property_url: z.string().url().describe("Full Booking.com hotel URL from search_hotels"),
        checkin: z.string().describe("Check-in date (YYYY-MM-DD)"),
        checkout: z.string().describe("Check-out date (YYYY-MM-DD)"),
        adults: z.number().int().min(1).max(30).default(2).describe("Number of adults"),
        rooms: z.number().int().min(1).max(10).default(1).optional().describe("Number of rooms"),
      }),
      annotations: { readOnlyHint: true as const, openWorldHint: true as const },
      async handler(page: Page, input: unknown) {
        const { property_url, checkin, checkout, adults, rooms } = z.object({
          property_url: z.string().url(),
          checkin: z.string(),
          checkout: z.string(),
          adults: z.number().default(2),
          rooms: z.number().default(1).optional(),
        }).parse(input);

        const u = new URL(property_url);
        u.searchParams.set("checkin", checkin);
        u.searchParams.set("checkout", checkout);
        u.searchParams.set("group_adults", String(adults));
        if (rooms && rooms > 1) u.searchParams.set("no_rooms", String(rooms));

        await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 25_000 });
        await page.waitForTimeout(2_000);

        const detail = await extractPropertyPage(page);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }],
        };
      },
    },

    // ── get_saved_properties ──────────────────────────────────────────────────
    {
      name: "get_saved_properties",
      description: [
        "Get your saved/wishlisted properties on Booking.com.",
        "Returns properties you've hearted/saved while browsing.",
        "Works in headless mode — no watch mode required.",
        "",
        "Returns: SavedProperty[] with name, location, rating, propertyUrl, rawText.",
        "Returns an empty array if your wishlist is empty.",
        "",
        "Pass propertyUrl to get_property or get_availability for full details and pricing.",
      ].join("\n"),
      inputSchema: z.object({
        count: z.number().int().min(1).max(100).default(20)
          .describe("Max number of saved properties to return (1–100)"),
      }),
      annotations: { readOnlyHint: true as const },
      async handler(page: Page, input: unknown) {
        const { count } = z.object({ count: z.number().default(20) }).parse(input);
        // extractSavedProperties navigates to mywishlist.html internally
        const results = await extractSavedProperties(page, count);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      },
    },

    // ── get_reviews ───────────────────────────────────────────────────────────
    {
      name: "get_reviews",
      description: [
        "Get guest reviews for a Booking.com property.",
        "Opens the 'Read all reviews' modal on the property page and extracts up to count reviews.",
        "Each review includes: reviewer name, country, score, date, review title, pros, cons,",
        "room type, stay duration, traveller type, and rawText for LLM fallback.",
        "",
        "Sort options (matching Booking.com's modal dropdown):",
        "  most_relevant (default), newest_first, oldest_first, highest_scores, lowest_scores",
        "",
        "Use get_saved_properties, search_hotels, or get_property to find a property_url first.",
        "",
        "Examples:",
        "  get_reviews({ property_url: 'https://www.booking.com/hotel/it/il-castelluccio-countryresort.html', count: 20 })",
        "  get_reviews({ property_url: '...', count: 50, sort: 'newest_first' })",
      ].join("\n"),
      inputSchema: z.object({
        property_url: z.string().url()
          .describe("Full Booking.com hotel URL — from search_hotels, get_saved_properties, etc."),
        count: z.number().int().min(1).max(75).default(10)
          .describe("Max reviews to return (1–75)"),
        sort: z.enum(["most_relevant", "newest_first", "oldest_first", "highest_scores", "lowest_scores"])
          .default("most_relevant")
          .optional()
          .describe("Sort order: most_relevant (default), newest_first, oldest_first, highest_scores, lowest_scores"),
      }),
      annotations: { readOnlyHint: true as const, openWorldHint: true as const },
      async handler(page: Page, input: unknown) {
        const { property_url, count, sort } = z.object({
          property_url: z.string().url(),
          count: z.number().int().min(1).max(75).default(10),
          sort: z.enum(["most_relevant", "newest_first", "oldest_first", "highest_scores", "lowest_scores"])
            .default("most_relevant")
            .optional(),
        }).parse(input);

        // Validate it's a Booking.com URL
        if (!property_url.includes("booking.com")) {
          return {
            content: [{ type: "text" as const, text: "Error: property_url must be a Booking.com hotel URL." }],
            isError: true,
          };
        }

        const reviews = await extractPropertyReviews(
          page,
          property_url,
          count,
          (sort ?? "most_relevant") as ReviewSort
        );

        return {
          content: [{ type: "text" as const, text: JSON.stringify(reviews, null, 2) }],
        };
      },
    },

  ],
});
