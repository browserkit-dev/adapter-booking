/**
 * L2 — Live Integration Tests
 *
 * Tests against real secure.booking.com — requires authentication.
 * Run ONLY locally after: browserkit login booking
 *
 * Usage: pnpm test:integration
 *
 * These tests are excluded from CI because:
 *   1. They require a real Booking.com account session
 *   2. Booking.com uses Cloudflare + fingerprinting (blocks CI IPs)
 *   3. They expose personal booking data
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bookingAdapter from "../src/index.js";
import { createTestAdapterServer, type TestAdapterServer } from "@browserkit/core/testing";
import { createTestMcpClient, type TestMcpClient } from "@browserkit/core/testing";
import type { Booking, BookingDetail } from "../src/scraper.js";

// ── Shared server ─────────────────────────────────────────────────────────────

let server: TestAdapterServer;
let client: TestMcpClient;

beforeAll(async () => {
  server = await createTestAdapterServer(bookingAdapter);
  client = await createTestMcpClient(server.url);
}, 30_000);

afterAll(async () => {
  await client.close();
  await server.stop();
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
        "Not logged in to Booking.com. Run: browserkit login booking\n" +
        "Then restart the test server and re-run this suite."
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
