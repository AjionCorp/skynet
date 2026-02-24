import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Mock auth module before importing route
vi.mock("../../../../lib/auth", () => ({
  safeCompare: vi.fn((a: string, b: string) => a === b),
  deriveSessionToken: vi.fn(() => "mock-session-token"),
}));

import { POST } from "./route";

function makeRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  const originalEnv = process.env.SKYNET_DASHBOARD_API_KEY;
  // Use unique IPs per test to avoid rate-limit cross-contamination
  let testIpCounter = 0;
  function uniqueIp(): string {
    testIpCounter++;
    return `10.0.0.${testIpCounter}`;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SKYNET_DASHBOARD_API_KEY = "test-api-key";
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.SKYNET_DASHBOARD_API_KEY = originalEnv;
    } else {
      delete process.env.SKYNET_DASHBOARD_API_KEY;
    }
  });

  it("returns 401 for invalid API key", async () => {
    const res = await POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": uniqueIp() }));
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.error).toContain("Invalid API key");
  });

  it("returns 200 and sets cookie for valid API key", async () => {
    const res = await POST(makeRequest({ apiKey: "test-api-key" }, { "x-real-ip": uniqueIp() }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // Check Set-Cookie header exists
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("skynet-api-key");
    expect(setCookie).toContain("HttpOnly");
    // Next.js lowercases SameSite value in the header
    expect(setCookie?.toLowerCase()).toContain("samesite=strict");
  });

  it("returns 400 for missing apiKey field", async () => {
    const res = await POST(makeRequest({ notApiKey: "value" }, { "x-real-ip": uniqueIp() }));
    expect(res.status).toBe(400);
  });

  it("returns 500 when API key not configured", async () => {
    delete process.env.SKYNET_DASHBOARD_API_KEY;
    const res = await POST(makeRequest({ apiKey: "any" }, { "x-real-ip": uniqueIp() }));
    expect(res.status).toBe(500);
  });

  it("returns 413 for oversized request body", async () => {
    const res = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "999999",
          "x-real-ip": uniqueIp(),
        },
        body: JSON.stringify({ apiKey: "test" }),
      })
    );
    expect(res.status).toBe(413);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-real-ip": uniqueIp(),
        },
        body: "not json {{{",
      })
    );
    expect(res.status).toBe(400);
  });
});
