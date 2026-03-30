/**
 * L1 — Unit Tests
 *
 * Pure fast tests: adapter metadata, tool names, Zod schemas, scraper helpers.
 * No browser, no network.
 */
import { describe, it, expect } from "vitest";
import adapter from "../src/index.js";
import {
  extractDateNear,
  extractPrice,
  extractConfirmationNumber,
  countNights,
  tripsUrl,
} from "../src/scraper.js";
import { SELECTORS } from "../src/selectors.js";

// ── Metadata ──────────────────────────────────────────────────────────────────

describe("Booking adapter metadata", () => {
  it("has correct site identifier", () => {
    expect(adapter.site).toBe("booking");
  });

  it("has correct domain", () => {
    expect(adapter.domain).toBe("booking.com");
  });

  it("loginUrl points to booking.com", () => {
    expect(adapter.loginUrl).toContain("booking.com");
    expect(adapter.loginUrl).toContain("www.booking.com");
  });

  it("exports selectors for health_check", () => {
    expect(adapter.selectors).toBeDefined();
    expect(typeof adapter.selectors?.accountMenu).toBe("string");
  });
});

// ── Tool registry ─────────────────────────────────────────────────────────────

describe("tool registry", () => {
  it("exposes all 3 Phase 1 tools", () => {
    const names = adapter.tools().map((t) => t.name);
    expect(names).toContain("get_upcoming_bookings");
    expect(names).toContain("get_past_bookings");
    expect(names).toContain("get_booking_details");
    expect(names).toHaveLength(7);
  });

  it("every tool has a non-empty description", () => {
    for (const tool of adapter.tools()) {
      expect(tool.description, `tool "${tool.name}" missing description`).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it("every tool has a handler function", () => {
    for (const tool of adapter.tools()) {
      expect(typeof tool.handler, `tool "${tool.name}" missing handler`).toBe("function");
    }
  });
});

// ── get_upcoming_bookings schema ──────────────────────────────────────────────

describe("get_upcoming_bookings schema", () => {
  const tool = () => adapter.tools().find((t) => t.name === "get_upcoming_bookings")!;

  it("accepts minimal input (uses default count=10)", () => {
    const result = tool().inputSchema.parse({});
    expect(result.count).toBe(10);
  });

  it("accepts count=1 (min)", () => {
    expect(tool().inputSchema.safeParse({ count: 1 }).success).toBe(true);
  });

  it("accepts count=50 (max)", () => {
    expect(tool().inputSchema.safeParse({ count: 50 }).success).toBe(true);
  });

  it("rejects count=0", () => {
    expect(tool().inputSchema.safeParse({ count: 0 }).success).toBe(false);
  });

  it("rejects count=51", () => {
    expect(tool().inputSchema.safeParse({ count: 51 }).success).toBe(false);
  });
});

// ── get_past_bookings schema ──────────────────────────────────────────────────

describe("get_past_bookings schema", () => {
  const tool = () => adapter.tools().find((t) => t.name === "get_past_bookings")!;

  it("accepts minimal input", () => {
    expect(tool().inputSchema.safeParse({}).success).toBe(true);
  });

  it("applies default count=10", () => {
    expect(tool().inputSchema.parse({}).count).toBe(10);
  });
});

// ── get_booking_details schema ────────────────────────────────────────────────

describe("get_booking_details schema", () => {
  const tool = () => adapter.tools().find((t) => t.name === "get_booking_details")!;

  it("accepts a confirmation number", () => {
    expect(tool().inputSchema.safeParse({ confirmation_number: "1234567890" }).success).toBe(true);
  });

  it("rejects empty confirmation_number", () => {
    expect(tool().inputSchema.safeParse({ confirmation_number: "" }).success).toBe(false);
  });

  it("rejects missing confirmation_number", () => {
    expect(tool().inputSchema.safeParse({}).success).toBe(false);
  });
});

// ── tripsUrl helper ───────────────────────────────────────────────────────────

describe("tripsUrl", () => {
  it("builds upcoming URL", () => {
    expect(tripsUrl("upcoming")).toBe("https://secure.booking.com/mytrips.html?status=upcoming");
  });

  it("builds past URL", () => {
    expect(tripsUrl("past")).toBe("https://secure.booking.com/mytrips.html?status=past");
  });

  it("builds cancelled URL", () => {
    expect(tripsUrl("cancelled")).toContain("cancelled");
  });
});

// ── extractDateNear helper ────────────────────────────────────────────────────

describe("extractDateNear", () => {
  it("extracts ISO date near keyword", () => {
    expect(extractDateNear("Check-in: 2026-04-15", "check-in")).toBe("2026-04-15");
  });

  it("extracts human date near keyword", () => {
    const result = extractDateNear("Check-in 15 Apr 2026", "check-in");
    expect(result).toContain("Apr");
  });

  it("returns empty string when keyword not found", () => {
    expect(extractDateNear("some random text", "check-in")).toBe("");
  });

  it("is case insensitive", () => {
    expect(extractDateNear("CHECK-IN: 2026-05-01", "check-in")).toBe("2026-05-01");
  });
});

// ── extractPrice helper ───────────────────────────────────────────────────────

describe("extractPrice", () => {
  it("extracts euro price", () => {
    expect(extractPrice("Total: € 320.00")).toContain("320");
  });

  it("extracts pound price", () => {
    expect(extractPrice("You paid £120")).toContain("120");
  });

  it("extracts dollar price", () => {
    expect(extractPrice("Amount: $199.99")).toContain("199");
  });

  it("returns empty string when no price found", () => {
    expect(extractPrice("no price here")).toBe("");
  });
});

// ── extractConfirmationNumber helper ─────────────────────────────────────────

describe("extractConfirmationNumber", () => {
  it("extracts number after Confirmation:", () => {
    expect(extractConfirmationNumber("Confirmation: 1234567890")).toBe("1234567890");
  });

  it("extracts number after Reference:", () => {
    expect(extractConfirmationNumber("Reference: ABC123XYZ")).toBe("ABC123XYZ");
  });

  it("is case insensitive", () => {
    expect(extractConfirmationNumber("CONFIRMATION: 9876543210")).toBe("9876543210");
  });

  it("returns empty string when not found", () => {
    expect(extractConfirmationNumber("no confirmation here")).toBe("");
  });
});

// ── countNights helper ────────────────────────────────────────────────────────

describe("countNights", () => {
  it("counts nights between two ISO dates", () => {
    expect(countNights("2026-04-15", "2026-04-18")).toBe(3);
  });

  it("returns 0 for same-day dates", () => {
    expect(countNights("2026-04-15", "2026-04-15")).toBe(0);
  });

  it("returns 0 for invalid dates", () => {
    expect(countNights("", "")).toBe(0);
    expect(countNights("not-a-date", "2026-04-18")).toBe(0);
  });

  it("returns 0 when checkout is before checkin", () => {
    expect(countNights("2026-04-18", "2026-04-15")).toBe(0);
  });
});

// ── SELECTORS export ──────────────────────────────────────────────────────────

describe("SELECTORS export", () => {
  it("loginForm selector is a non-empty string", () => {
    expect(typeof SELECTORS.loginForm).toBe("string");
    expect(SELECTORS.loginForm.length).toBeGreaterThan(0);
  });

  it("accountMenu selector is a non-empty string", () => {
    expect(typeof SELECTORS.accountMenu).toBe("string");
  });
});

// ── Tool registry (Phase 2) ───────────────────────────────────────────────────

describe("tool registry (Phase 2)", () => {
  it("exposes all 7 tools (3 Phase 1 + 3 Phase 2 search + 1 saved)", () => {
    const names = adapter.tools().map((t) => t.name);
    expect(names).toContain("search_hotels");
    expect(names).toContain("get_property");
    expect(names).toContain("get_availability");
    expect(names).toContain("get_saved_properties");
    expect(names).toHaveLength(7);
  });
});

// ── search_hotels schema ──────────────────────────────────────────────────────

describe("search_hotels schema", () => {
  const tool = () => adapter.tools().find((t) => t.name === "search_hotels")!;

  it("accepts valid input", () => {
    expect(tool().inputSchema.safeParse({
      destination: "Amsterdam",
      checkin: "2026-06-01",
      checkout: "2026-06-04",
    }).success).toBe(true);
  });

  it("applies defaults (adults=2, rooms=1, count=10, sort=popularity)", () => {
    const result = tool().inputSchema.parse({ destination: "Amsterdam", checkin: "2026-06-01", checkout: "2026-06-04" });
    expect(result.adults).toBe(2);
    expect(result.rooms).toBe(1);
    expect(result.count).toBe(10);
  });

  it("rejects empty destination", () => {
    expect(tool().inputSchema.safeParse({ destination: "", checkin: "2026-06-01", checkout: "2026-06-04" }).success).toBe(false);
  });

  it("rejects missing checkin", () => {
    expect(tool().inputSchema.safeParse({ destination: "Amsterdam", checkout: "2026-06-04" }).success).toBe(false);
  });

  it("rejects missing checkout", () => {
    expect(tool().inputSchema.safeParse({ destination: "Amsterdam", checkin: "2026-06-01" }).success).toBe(false);
  });

  it("accepts valid sort values", () => {
    for (const sort of ["popularity", "price", "review_score", "distance"]) {
      expect(tool().inputSchema.safeParse({
        destination: "Amsterdam", checkin: "2026-06-01", checkout: "2026-06-04", sort,
      }).success).toBe(true);
    }
  });

  it("rejects invalid sort", () => {
    expect(tool().inputSchema.safeParse({
      destination: "Amsterdam", checkin: "2026-06-01", checkout: "2026-06-04", sort: "stars",
    }).success).toBe(false);
  });

  it("rejects count=0", () => {
    expect(tool().inputSchema.safeParse({
      destination: "Amsterdam", checkin: "2026-06-01", checkout: "2026-06-04", count: 0,
    }).success).toBe(false);
  });

  it("rejects count=26", () => {
    expect(tool().inputSchema.safeParse({
      destination: "Amsterdam", checkin: "2026-06-01", checkout: "2026-06-04", count: 26,
    }).success).toBe(false);
  });
});

// ── get_property schema ───────────────────────────────────────────────────────

describe("get_property schema", () => {
  const tool = () => adapter.tools().find((t) => t.name === "get_property")!;
  const validUrl = "https://www.booking.com/hotel/nl/some-hotel.html";

  it("accepts minimal input (URL only)", () => {
    expect(tool().inputSchema.safeParse({ property_url: validUrl }).success).toBe(true);
  });

  it("accepts URL with checkin/checkout", () => {
    expect(tool().inputSchema.safeParse({
      property_url: validUrl, checkin: "2026-06-01", checkout: "2026-06-04",
    }).success).toBe(true);
  });

  it("rejects non-URL property_url", () => {
    expect(tool().inputSchema.safeParse({ property_url: "not-a-url" }).success).toBe(false);
  });

  it("rejects missing property_url", () => {
    expect(tool().inputSchema.safeParse({}).success).toBe(false);
  });

  it("checkin/checkout are optional", () => {
    expect(tool().inputSchema.safeParse({ property_url: validUrl }).success).toBe(true);
  });
});

// ── get_availability schema ───────────────────────────────────────────────────

describe("get_availability schema", () => {
  const tool = () => adapter.tools().find((t) => t.name === "get_availability")!;
  const validUrl = "https://www.booking.com/hotel/nl/some-hotel.html";

  it("accepts valid input", () => {
    expect(tool().inputSchema.safeParse({
      property_url: validUrl, checkin: "2026-06-01", checkout: "2026-06-04",
    }).success).toBe(true);
  });

  it("rejects missing checkin", () => {
    expect(tool().inputSchema.safeParse({ property_url: validUrl, checkout: "2026-06-04" }).success).toBe(false);
  });

  it("rejects missing checkout", () => {
    expect(tool().inputSchema.safeParse({ property_url: validUrl, checkin: "2026-06-01" }).success).toBe(false);
  });

  it("rejects non-URL property_url", () => {
    expect(tool().inputSchema.safeParse({
      property_url: "not-a-url", checkin: "2026-06-01", checkout: "2026-06-04",
    }).success).toBe(false);
  });

  it("applies default adults=2", () => {
    const result = tool().inputSchema.parse({ property_url: validUrl, checkin: "2026-06-01", checkout: "2026-06-04" });
    expect(result.adults).toBe(2);
  });
});

// ── get_saved_properties schema ───────────────────────────────────────────────

describe("get_saved_properties schema", () => {
  const tool = () => adapter.tools().find((t) => t.name === "get_saved_properties")!;

  it("tool exists", () => {
    expect(tool()).toBeDefined();
  });

  it("applies default count=20", () => {
    expect(tool().inputSchema.parse({}).count).toBe(20);
  });

  it("accepts count=1 (min)", () => {
    expect(tool().inputSchema.safeParse({ count: 1 }).success).toBe(true);
  });

  it("accepts count=100 (max)", () => {
    expect(tool().inputSchema.safeParse({ count: 100 }).success).toBe(true);
  });

  it("rejects count=0", () => {
    expect(tool().inputSchema.safeParse({ count: 0 }).success).toBe(false);
  });

  it("rejects count=101", () => {
    expect(tool().inputSchema.safeParse({ count: 101 }).success).toBe(false);
  });
});


