import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

// Mock auth module before importing route
vi.mock("../../../../lib/auth", () => ({
  safeCompare: vi.fn(async (a: string, b: string) => a === b),
  deriveSessionToken: vi.fn(async () => "mock-session-token"),
}));

import { POST, _LOGIN_ATTEMPTS_FOR_TESTING } from "./route";

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
  const originalTrustProxy = process.env.SKYNET_TRUST_PROXY;
  // Use unique IPs per test to avoid rate-limit cross-contamination
  let testIpCounter = 0;
  function uniqueIp(): string {
    testIpCounter++;
    return `10.0.0.${testIpCounter}`;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SKYNET_DASHBOARD_API_KEY = "test-api-key";
    delete process.env.SKYNET_TRUST_PROXY;
  });

  // TEST-P1-6: Clear rate limit state between tests to prevent leakage between describe blocks.
  // Without this, failed login attempts from one test can cause unexpected 429 responses in later tests.
  afterEach(() => {
    _LOGIN_ATTEMPTS_FOR_TESTING.clear();
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.SKYNET_DASHBOARD_API_KEY = originalEnv;
    } else {
      delete process.env.SKYNET_DASHBOARD_API_KEY;
    }
    if (originalTrustProxy !== undefined) {
      process.env.SKYNET_TRUST_PROXY = originalTrustProxy;
    } else {
      delete process.env.SKYNET_TRUST_PROXY;
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
    expect(body.data.ok).toBe(true);
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

  // ── TEST-P1-1: Rate limit boundary tests ──────────────────────────────
  describe("rate limit boundary conditions", () => {
    it("allows exactly MAX_ATTEMPTS (5) failed attempts", async () => {
      const ip = uniqueIp();
      // 5 failed attempts should all return 401 (not 429)
      for (let i = 0; i < 5; i++) {
        const res = await POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": ip }));
        expect(res.status).toBe(401);
      }
    });

    it("blocks on attempt 6 (one over the limit)", async () => {
      const ip = uniqueIp();
      // 5 failed attempts
      for (let i = 0; i < 5; i++) {
        await POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": ip }));
      }
      // 6th attempt should be rate limited
      const res = await POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": ip }));
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toContain("Too many login attempts");
    });

    it("allows login again after window expires", async () => {
      process.env.SKYNET_TRUST_PROXY = "true";
      const ip = uniqueIp();
      // Fill up the rate limit
      for (let i = 0; i < 5; i++) {
        await POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": ip }));
      }
      // Verify blocked
      const blocked = await POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": ip }));
      expect(blocked.status).toBe(429);

      // Manually expire the entry by manipulating the internal map
      const entry = _LOGIN_ATTEMPTS_FOR_TESTING.get(ip);
      expect(entry).toBeDefined();
      // Set resetAt to the past
      entry!.resetAt = Date.now() - 1;

      // Should now be allowed again
      const res = await POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": ip }));
      expect(res.status).toBe(401); // 401 = not rate limited, just wrong key
    });
  });

  describe("proxy trust handling", () => {
    it("ignores spoofed x-real-ip headers when proxy trust is disabled", async () => {
      for (let i = 0; i < 5; i++) {
        const res = await POST(
          makeRequest(
            { apiKey: "wrong-key" },
            { "x-real-ip": `203.0.113.${i + 1}` }
          )
        );
        expect(res.status).toBe(401);
      }

      const blocked = await POST(
        makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": "203.0.113.99" })
      );
      expect(blocked.status).toBe(429);
      expect(_LOGIN_ATTEMPTS_FOR_TESTING.has("unknown")).toBe(true);
    });

    it("uses trusted proxy headers when SKYNET_TRUST_PROXY is enabled", async () => {
      process.env.SKYNET_TRUST_PROXY = "true";

      for (let i = 0; i < 5; i++) {
        const res = await POST(
          makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": "198.51.100.42" })
        );
        expect(res.status).toBe(401);
      }

      const blocked = await POST(
        makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": "198.51.100.42" })
      );
      expect(blocked.status).toBe(429);
      expect(_LOGIN_ATTEMPTS_FOR_TESTING.has("198.51.100.42")).toBe(true);
    });
  });

  // ── TEST-P1-4: Concurrent rate limit race test ────────────────────────
  describe("concurrent rate limit checks", () => {
    it("handles concurrent requests to the same IP without counter corruption", async () => {
      process.env.SKYNET_TRUST_PROXY = "true";
      const ip = uniqueIp();
      // Send 5 concurrent failed login requests from the same IP
      const promises = Array.from({ length: 5 }, () =>
        POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": ip }))
      );
      const results = await Promise.all(promises);

      // All 5 should be 401 (failed auth, not yet rate limited)
      for (const res of results) {
        expect(res.status).toBe(401);
      }

      // The internal counter should reflect all 5 attempts
      const entry = _LOGIN_ATTEMPTS_FOR_TESTING.get(ip);
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(5);

      // The next request should be rate limited (429)
      const nextRes = await POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": ip }));
      expect(nextRes.status).toBe(429);
    });

    it("does not corrupt counter when concurrent valid and invalid requests race", async () => {
      const ip = uniqueIp();
      // Mix of valid and invalid concurrent requests
      const promises = [
        POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": ip })),
        POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": ip })),
        POST(makeRequest({ apiKey: "test-api-key" }, { "x-real-ip": ip })),
        POST(makeRequest({ apiKey: "wrong-key" }, { "x-real-ip": ip })),
      ];
      const results = await Promise.all(promises);

      // At least one should succeed (200) and some should fail (401)
      const statuses = results.map(r => r.status);
      expect(statuses).toContain(200);
      expect(statuses.filter(s => s === 401).length).toBeGreaterThan(0);
    });
  });
});


// TEST-P3-5: CORS headers verification
describe("CORS headers on API responses", () => {
  const originalEnv = process.env.SKYNET_DASHBOARD_API_KEY;

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

  it("does not set CORS headers by default (reverse proxy responsibility)", async () => {
    const res = await POST(makeRequest({ apiKey: "test-api-key" }, { "x-real-ip": "10.0.99.1" }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("401 responses do not leak CORS headers", async () => {
    const res = await POST(makeRequest({ apiKey: "wrong" }, { "x-real-ip": "10.0.99.2" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ── P0-7: Critical missing tests ──────────────────────────────────

describe("POST /api/auth/login — missing fields", () => {
  const originalEnv = process.env.SKYNET_DASHBOARD_API_KEY;
  let testIpCounter = 200;
  function uniqueIp(): string {
    testIpCounter++;
    return `10.0.200.${testIpCounter}`;
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

  it("returns 400 when body has no apiKey and no password", async () => {
    const res = await POST(makeRequest({}, { "x-real-ip": uniqueIp() }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when apiKey is a number instead of string", async () => {
    const res = await POST(makeRequest({ apiKey: 12345 }, { "x-real-ip": uniqueIp() }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when apiKey is null", async () => {
    const res = await POST(makeRequest({ apiKey: null }, { "x-real-ip": uniqueIp() }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is an empty object", async () => {
    const res = await POST(makeRequest({}, { "x-real-ip": uniqueIp() }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when body has password field instead of apiKey", async () => {
    const res = await POST(makeRequest({ password: "test-api-key" }, { "x-real-ip": uniqueIp() }));
    expect(res.status).toBe(400);
  });
});

describe("rate limit map cleanup determinism", () => {
  const originalEnv = process.env.SKYNET_DASHBOARD_API_KEY;
  let testIpCounter = 300;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SKYNET_DASHBOARD_API_KEY = "test-api-key";
    // Clear the rate limit map before this test suite
    _LOGIN_ATTEMPTS_FOR_TESTING.clear();
  });

  afterAll(() => {
    _LOGIN_ATTEMPTS_FOR_TESTING.clear();
    if (originalEnv !== undefined) {
      process.env.SKYNET_DASHBOARD_API_KEY = originalEnv;
    } else {
      delete process.env.SKYNET_DASHBOARD_API_KEY;
    }
  });

  it("cleanup removes expired entries when map exceeds MAX_TRACKED_IPS", async () => {
    // MAX_TRACKED_IPS is 1000 — fill with 1001 expired entries
    const now = Date.now();
    for (let i = 0; i < 1001; i++) {
      _LOGIN_ATTEMPTS_FOR_TESTING.set(`expired-${i}`, {
        count: 1,
        resetAt: now - 1000, // expired 1 second ago
      });
    }

    expect(_LOGIN_ATTEMPTS_FOR_TESTING.size).toBe(1001);

    // Next request should trigger cleanup of all expired entries
    const ip = `10.0.${300 + (testIpCounter++)}.1`;
    await POST(makeRequest({ apiKey: "wrong" }, { "x-real-ip": ip }));

    // All 1001 expired entries should have been purged, leaving only the new one
    // (The new request creates a fresh entry for its IP)
    expect(_LOGIN_ATTEMPTS_FOR_TESTING.size).toBeLessThanOrEqual(2);
  });

  it("cleanup evicts oldest non-expired entries when over limit after purge", async () => {
    // Fill with 1001 non-expired entries (future resetAt)
    const now = Date.now();
    for (let i = 0; i < 1001; i++) {
      _LOGIN_ATTEMPTS_FOR_TESTING.set(`active-${i}`, {
        count: 1,
        resetAt: now + 60000 + i, // expires in the future, ascending order
      });
    }

    expect(_LOGIN_ATTEMPTS_FOR_TESTING.size).toBe(1001);

    // Next request triggers cleanup: expired purge removes 0, then oldest eviction kicks in
    const ip = `10.0.${300 + (testIpCounter++)}.1`;
    await POST(makeRequest({ apiKey: "wrong" }, { "x-real-ip": ip }));

    // Map should be at or below MAX_TRACKED_IPS (1000) + the new entry
    expect(_LOGIN_ATTEMPTS_FOR_TESTING.size).toBeLessThanOrEqual(1001);

    // The oldest entry (active-0 with lowest resetAt) should have been evicted
    expect(_LOGIN_ATTEMPTS_FOR_TESTING.has("active-0")).toBe(false);
  });
});
