/**
 * L3 — MCP Protocol Tests (structural, no live booking.com calls)
 *
 * Tests that run in CI without any Booking.com access:
 * server lifecycle, tool registry, health check, schema validation, bearer token.
 *
 * Live booking tests (requiring auth) are in booking.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bookingAdapter from "../src/index.js";
import { createTestAdapterServer, type TestAdapterServer } from "@browserkit/core/testing";
import { createTestMcpClient, type TestMcpClient } from "@browserkit/core/testing";

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

// ── Tool registry ─────────────────────────────────────────────────────────────

describe("tool registry", () => {
  it("lists all 3 adapter tools", async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_upcoming_bookings");
    expect(names).toContain("get_past_bookings");
    expect(names).toContain("get_booking_details");
    expect(names).toContain("search_hotels");
    expect(names).toContain("get_property");
    expect(names).toContain("get_availability");
  });

  it("includes auto-registered browser management tool", async () => {
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("browser");
  });

  it("all tools have descriptions", async () => {
    const tools = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, `tool "${tool.name}" missing description`).toBeTruthy();
    }
  });
});

// ── health_check ──────────────────────────────────────────────────────────────

describe("health_check", () => {
  it("reports site=booking, mode=headless", async () => {
    const result = await client.callTool("browser", { action: "health_check" });
    expect(result.isError).toBeFalsy();

    const status = JSON.parse(result.content[0]?.text ?? "{}") as {
      site: string;
      mode: string;
    };

    expect(status.site).toBe("booking");
    expect(status.mode).toBe("headless");
  });
});

// ── page_state ────────────────────────────────────────────────────────────────

describe("page_state", () => {
  it("returns url, title, mode, isPaused", async () => {
    const result = await client.callTool("browser", { action: "page_state" });
    expect(result.isError).toBeFalsy();

    const state = JSON.parse(result.content[0]?.text ?? "{}") as {
      url: string;
      title: string;
      mode: string;
      isPaused: boolean;
    };

    expect(typeof state.url).toBe("string");
    expect(state.mode).toBe("headless");
    expect(state.isPaused).toBe(false);
  });
});

// ── Schema validation errors ──────────────────────────────────────────────────

describe("schema validation errors", () => {
  it("error for count=0 in get_upcoming_bookings", async () => {
    const result = await client.callTool("get_upcoming_bookings", { count: 0 }).catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toMatch(/validation|invalid/i);
    } else {
      expect(result.isError).toBe(true);
    }
  });

  it("error for count=51 in get_past_bookings", async () => {
    const result = await client.callTool("get_past_bookings", { count: 51 }).catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toMatch(/validation|invalid/i);
    } else {
      expect(result.isError).toBe(true);
    }
  });

  it("error for missing confirmation_number in get_booking_details", async () => {
    const result = await client.callTool("get_booking_details", {}).catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toMatch(/validation|invalid/i);
    } else {
      expect(result.isError).toBe(true);
    }
  });

  it("error for empty confirmation_number in get_booking_details", async () => {
    const result = await client.callTool("get_booking_details", { confirmation_number: "" }).catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toMatch(/validation|invalid/i);
    } else {
      expect(result.isError).toBe(true);
    }
  });
});

// ── Bearer token auth ─────────────────────────────────────────────────────────

describe("bearer token auth", () => {
  let protectedServer: TestAdapterServer;

  beforeAll(async () => {
    protectedServer = await createTestAdapterServer(bookingAdapter, "test-secret-token");
  }, 30_000);

  afterAll(async () => {
    await protectedServer.stop();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const unauthClient = await createTestMcpClient(protectedServer.url).catch((e) => e);
    if (unauthClient instanceof Error) {
      expect(unauthClient.message).toBeTruthy();
    } else {
      const result = await unauthClient.callTool("browser", { action: "health_check" }).catch((e: Error) => e);
      expect(result instanceof Error).toBe(true);
      await unauthClient.close();
    }
  });
});
