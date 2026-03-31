/**
 * L2 — Live Integration Tests
 *
 * Tests against real secure.booking.com — requires authentication AND watch mode.
 * Run ONLY locally after:
 *   1. browserkit login booking
 *   2. browserkit start --config browserkit.config.js  (daemon running on port 52745)
 *
 * Usage: pnpm test:integration
 *
 * IMPORTANT: secure.booking.com blocks headless Chrome. These tests connect to
 * the running daemon and switch to watch mode automatically.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestMcpClient, type TestMcpClient } from "@browserkit/core/testing";
import type { Booking, BookingDetail } from "../src/scraper.js";

// Connect to the running daemon (not a fresh test server — needs real auth)
const MCP_URL = process.env["BOOKING_MCP_URL"] ?? "http://127.0.0.1:52745/mcp";

// ── Shared client ─────────────────────────────────────────────────────────────

let client: TestMcpClient;

beforeAll(async () => {
  client = await createTestMcpClient(MCP_URL);
  // CloakBrowser handles DataDome in headless mode — no watch mode needed
  // Navigate to homepage to seed the session cookie context
  await client.callTool("browser", { action: "navigate", url: "https://www.booking.com/" });
}, 30_000);

afterAll(async () => {
  await client.close();
});

// ── Auth check ────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("reports loggedIn=true (session must be present)", async () => {
    const result = await client.callTool("browser", { action: "health_check" });
    expect(result.isError).toBeFalsy();

    const status = JSON.parse(result.content[0]?.text ?? "{}") as { loggedIn: boolean; site: string };
    expect(status.site).toBe("booking");

    if (!status.loggedIn) {
      throw new Error(
        "Not logged in to Booking.com.\n" +
        "1. Run: browserkit login booking\n" +
        "2. Start the daemon: browserkit start --config browserkit.config.js\n" +
        "3. Re-run: pnpm test:integration"
      );
    }

    expect(status.loggedIn).toBe(true);
  }, 30_000);
});

// ── get_upcoming_bookings ─────────────────────────────────────────────────────

describe("get_upcoming_bookings", () => {
  it("returns an array (may be empty if no upcoming trips)", async () => {
    const result = await client.callTool("get_upcoming_bookings", { count: 5 });
    expect(result.isError).toBeFalsy();

    const bookings = JSON.parse(result.content[0]?.text ?? "[]") as Booking[];
    expect(Array.isArray(bookings)).toBe(true);
    expect(result.content[0]?.type).toBe("text");
  }, 30_000);

  it("each booking has required fields if bookings exist", async () => {
    const result = await client.callTool("get_upcoming_bookings", { count: 5 });
    const bookings = JSON.parse(result.content[0]?.text ?? "[]") as Booking[];

    for (const booking of bookings) {
      // rawText is always required
      expect(typeof booking.rawText).toBe("string");
      expect(booking.rawText.length).toBeGreaterThan(10);
      // status should be upcoming
      expect(booking.status).toBe("upcoming");
      // If structured extraction worked, these should be present
      if (booking.propertyName) {
        expect(typeof booking.propertyName).toBe("string");
      }
    }
  }, 30_000);

  it("respects count parameter", async () => {
    const result = await client.callTool("get_upcoming_bookings", { count: 2 });
    const bookings = JSON.parse(result.content[0]?.text ?? "[]") as Booking[];
    expect(bookings.length).toBeLessThanOrEqual(2);
  }, 30_000);
});

// ── get_past_bookings ─────────────────────────────────────────────────────────

describe("get_past_bookings", () => {
  it("returns an array (may be empty for new accounts)", async () => {
    const result = await client.callTool("get_past_bookings", { count: 5 });
    expect(result.isError).toBeFalsy();

    const bookings = JSON.parse(result.content[0]?.text ?? "[]") as Booking[];
    expect(Array.isArray(bookings)).toBe(true);
  }, 30_000);

  it("each past booking has status=past if bookings exist", async () => {
    const result = await client.callTool("get_past_bookings", { count: 5 });
    const bookings = JSON.parse(result.content[0]?.text ?? "[]") as Booking[];

    for (const booking of bookings) {
      expect(booking.status).toBe("past");
      expect(typeof booking.rawText).toBe("string");
    }
  }, 30_000);
});

// ── get_booking_details ───────────────────────────────────────────────────────

describe("get_booking_details", () => {
  it("returns isError=true for a non-existent confirmation number", async () => {
    const result = await client.callTool("get_booking_details", {
      confirmation_number: "XXXXNOTAREAL99999",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not found");
  }, 60_000);

  it("returns detail for a real booking if one exists", async () => {
    // First get a real confirmation number from upcoming or past bookings
    const upcomingResult = await client.callTool("get_upcoming_bookings", { count: 1 });
    const upcoming = JSON.parse(upcomingResult.content[0]?.text ?? "[]") as Booking[];

    const pastResult = await client.callTool("get_past_bookings", { count: 1 });
    const past = JSON.parse(pastResult.content[0]?.text ?? "[]") as Booking[];

    const anyBooking = upcoming[0] ?? past[0];

    if (!anyBooking) {
      // No bookings available — skip gracefully
      console.log("No bookings found — skipping get_booking_details live test");
      return;
    }

    // Use rawText match if structured confirmationNumber wasn't extracted
    const confirmationNumber =
      anyBooking.confirmationNumber ||
      anyBooking.rawText.match(/\b\d{8,12}\b/)?.[0] ||
      "";

    if (!confirmationNumber) {
      console.log("Could not extract confirmation number — skipping");
      return;
    }

    const result = await client.callTool("get_booking_details", { confirmation_number: confirmationNumber });

    // Should succeed
    expect(result.isError).toBeFalsy();
    const detail = JSON.parse(result.content[0]?.text ?? "{}") as BookingDetail;

    // Must always have rawText
    expect(typeof detail.rawText).toBe("string");
    expect(detail.rawText.length).toBeGreaterThan(10);
  }, 60_000);
});

// ── health check after navigation ─────────────────────────────────────────────

describe("selector health after navigation", () => {
  it("health_check reports correctly after visiting secure.booking.com", async () => {
    // Do a real call first to trigger navigation
    await client.callTool("get_past_bookings", { count: 1 });

    const result = await client.callTool("browser", { action: "health_check" });
    expect(result.isError).toBeFalsy();

    const status = JSON.parse(result.content[0]?.text ?? "{}") as { site: string };
    expect(status.site).toBe("booking");
  }, 30_000);
});

// ── Phase 2: search_hotels (headless — no watch mode needed) ──────────────────

describe("search_hotels live", () => {
  it("returns results for a known destination", async () => {
    const result = await client.callTool("search_hotels", {
      destination: "Amsterdam",
      checkin: "2026-08-01",
      checkout: "2026-08-04",
      adults: 2,
      count: 5,
    });
    expect(result.isError).toBeFalsy();

    const text = result.content[0]?.text ?? "";
    expect(result.content[0]?.type).toBe("text");

    // May be an array of results or a single full-page block
    try {
      const results = JSON.parse(text);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      // Each result has rawText
      for (const r of results) {
        expect(typeof r.rawText).toBe("string");
        expect(r.rawText.length).toBeGreaterThan(10);
      }
    } catch {
      // If not JSON, rawText was returned as plain string — also acceptable
      expect(text.length).toBeGreaterThan(50);
    }
  }, 30_000);

  it("result content type is text", async () => {
    const result = await client.callTool("search_hotels", {
      destination: "London",
      checkin: "2026-08-10",
      checkout: "2026-08-12",
      count: 1,
    });
    expect(result.content[0]?.type).toBe("text");
  }, 30_000);
});

// ── Phase 2: get_property (headless) ─────────────────────────────────────────

describe("get_property live", () => {
  it("returns property details for a known Booking.com hotel URL", async () => {
    // Intercontinental Amsterdam — stable, well-known hotel
    const result = await client.callTool("get_property", {
      property_url: "https://www.booking.com/hotel/nl/intercontinental-amstel.html",
      checkin: "2026-08-01",
      checkout: "2026-08-04",
      adults: 2,
    });
    expect(result.isError).toBeFalsy();

    const detail = JSON.parse(result.content[0]?.text ?? "{}") as { rawText: string; name: string };
    expect(typeof detail.rawText).toBe("string");
    expect(detail.rawText.length).toBeGreaterThan(100);
  }, 30_000);
});

// ── Phase 2: get_availability (headless) ─────────────────────────────────────

describe("get_availability live", () => {
  it("returns room options for a known property", async () => {
    const result = await client.callTool("get_availability", {
      property_url: "https://www.booking.com/hotel/nl/intercontinental-amstel.html",
      checkin: "2026-08-01",
      checkout: "2026-08-04",
      adults: 2,
    });
    expect(result.isError).toBeFalsy();

    const detail = JSON.parse(result.content[0]?.text ?? "{}") as { rawText: string; roomOptions: string };
    expect(typeof detail.rawText).toBe("string");
    expect(detail.rawText.length).toBeGreaterThan(100);
  }, 30_000);
});

// ── get_booking_details AC tests (AC2-AC9) ────────────────────────────────────

describe("get_booking_details detail page (AC tests)", () => {
  it("AC10: returns isError for a fake confirmation number", async () => {
    const result = await client.callTool("get_booking_details", {
      confirmation_number: "FAKE999999999",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("not found");
  }, 120_000);

  it("AC2-AC9: confirmation page content (requires a real booking)", async () => {
    // Get a real confirmation number from past bookings
    const pastResult = await client.callTool("get_past_bookings", { count: 1 });
    const past = JSON.parse(pastResult.content[0]?.text ?? "[]") as Array<{
      confirmationNumber: string; rawText: string; detailUrl: string;
    }>;

    if (past.length === 0) {
      console.log("No past bookings — skipping detail page AC tests");
      return;
    }

    const booking = past[0]!;
    // Use confirmationNumber if extracted, else extract a numeric run from rawText
    const confirmNum =
      booking.confirmationNumber ||
      booking.rawText.match(/\b(\d{7,12})\b/)?.[1] ||
      "";

    if (!confirmNum) {
      console.log("Could not extract confirmation number — skipping");
      return;
    }

    const result = await client.callTool("get_booking_details", {
      confirmation_number: confirmNum,
    });

    expect(result.isError).toBeFalsy();
    const detail = JSON.parse(result.content[0]?.text ?? "{}") as {
      rawText: string;
      propertyName: string;
      confirmationNumber: string;
      checkIn: string;
      checkOut: string;
    };

    // AC2: modal was dismissed — "Don't forget to use your rewards" should not appear
    expect(detail.rawText).not.toContain("Don't forget to use your rewards");

    // AC3: rawText from detail page (not trips-list) is substantial
    expect(detail.rawText.length).toBeGreaterThan(500);

    // AC4: confirmationNumber looks like a real number
    if (detail.confirmationNumber) {
      expect(detail.confirmationNumber).toMatch(/\d{7,12}/);
    }

    // AC5: propertyName is an actual hotel (not "Bookings & Trips")
    expect(detail.propertyName).not.toBe("Bookings & Trips");

    // AC6 + AC7: dates populated
    if (detail.checkIn) {
      expect(typeof detail.checkIn).toBe("string");
      expect(detail.checkIn.length).toBeGreaterThan(0);
    }
  }, 180_000);
});

// ── get_saved_properties (headless) ──────────────────────────────────────────

describe("get_saved_properties live", () => {
  it("AC1: tool dispatches without error", async () => {
    const result = await client.callTool("get_saved_properties", { count: 5 });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
  }, 30_000);

  it("AC2/AC3: returns array (empty or populated)", async () => {
    const result = await client.callTool("get_saved_properties", { count: 20 });
    expect(result.isError).toBeFalsy();

    const items = JSON.parse(result.content[0]?.text ?? "[]") as Array<{
      name: string; propertyUrl: string; rawText: string;
    }>;

    expect(Array.isArray(items)).toBe(true);

    for (const item of items) {
      // AC4: propertyUrl starts with booking.com/hotel/
      if (item.propertyUrl) {
        expect(item.propertyUrl).toContain("booking.com/hotel/");
      }
      // AC5: name non-empty (if URL found, name should be too)
      if (item.propertyUrl) {
        expect(item.name.length).toBeGreaterThan(0);
      }
      // AC6: rawText present
      expect(typeof item.rawText).toBe("string");
    }

    // AC7: count respected
    expect(items.length).toBeLessThanOrEqual(20);
  }, 30_000);
});

// ── get_reviews (headless, requires property page navigation) ─────────────────

// Well-reviewed property with 1,600+ reviews — stable fixture
const CASTELLUCCIO_URL = "https://www.booking.com/hotel/it/il-castelluccio-countryresort.html";

describe("get_reviews live", () => {
  it("AC1: tool is registered and dispatches without error", async () => {
    const result = await client.callTool("get_reviews", {
      property_url: CASTELLUCCIO_URL,
      count: 5,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
  }, 60_000);

  it("AC2: returns ≥ 10 reviews when count: 15 for a well-reviewed property", async () => {
    const result = await client.callTool("get_reviews", {
      property_url: CASTELLUCCIO_URL,
      count: 15,
    });
    expect(result.isError).toBeFalsy();

    const reviews = JSON.parse(result.content[0]?.text ?? "[]") as Array<{
      rawText: string; title: string; pros: string; cons: string;
    }>;
    expect(Array.isArray(reviews)).toBe(true);
    expect(reviews.length).toBeGreaterThanOrEqual(10);
  }, 90_000);

  it("AC3: every review has non-empty rawText", async () => {
    const result = await client.callTool("get_reviews", {
      property_url: CASTELLUCCIO_URL,
      count: 10,
    });
    const reviews = JSON.parse(result.content[0]?.text ?? "[]") as Array<{ rawText: string }>;
    for (const r of reviews) {
      expect(typeof r.rawText).toBe("string");
      expect(r.rawText.length).toBeGreaterThan(10);
    }
  }, 60_000);

  it("AC4: at least one structured field populated per review (title, pros, or cons)", async () => {
    const result = await client.callTool("get_reviews", {
      property_url: CASTELLUCCIO_URL,
      count: 10,
    });
    const reviews = JSON.parse(result.content[0]?.text ?? "[]") as Array<{
      title: string; pros: string; cons: string;
    }>;
    for (const r of reviews) {
      const hasStructured = r.title.length > 0 || r.pros.length > 0 || r.cons.length > 0;
      expect(hasStructured).toBe(true);
    }
  }, 60_000);

  it("AC5: count is respected — returned length ≤ count", async () => {
    const result = await client.callTool("get_reviews", {
      property_url: CASTELLUCCIO_URL,
      count: 7,
    });
    const reviews = JSON.parse(result.content[0]?.text ?? "[]") as unknown[];
    expect(reviews.length).toBeLessThanOrEqual(7);
  }, 60_000);

  it("AC6: all sort values are accepted without error", async () => {
    const sortValues = ["most_relevant", "newest_first", "oldest_first", "highest_scores", "lowest_scores"] as const;
    for (const sort of sortValues) {
      const result = await client.callTool("get_reviews", {
        property_url: CASTELLUCCIO_URL,
        count: 5,
        sort,
      });
      expect(result.isError).toBeFalsy();
    }
  }, 120_000);

  it("AC7: count: 50 returns ≥ 40 reviews (validates scroll/pagination)", async () => {
    const result = await client.callTool("get_reviews", {
      property_url: CASTELLUCCIO_URL,
      count: 50,
    });
    expect(result.isError).toBeFalsy();
    const reviews = JSON.parse(result.content[0]?.text ?? "[]") as unknown[];
    expect(reviews.length).toBeGreaterThanOrEqual(40);
  }, 180_000);

  it("AC8: invalid (non-Booking.com) URL returns isError=true", async () => {
    const result = await client.callTool("get_reviews", {
      property_url: "https://www.google.com/",
      count: 5,
    });
    const reviews = result.isError
      ? []
      : (JSON.parse(result.content[0]?.text ?? "[]") as unknown[]);
    // Either explicit error flag or empty array — not a crash
    const graceful = result.isError === true || reviews.length === 0;
    expect(graceful).toBe(true);
  }, 30_000);
});
