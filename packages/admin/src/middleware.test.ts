import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Mock auth module before importing middleware
vi.mock("./lib/auth", () => ({
  safeCompare: vi.fn(async (a: string, b: string) => a === b),
  deriveSessionToken: vi.fn(async () => "mock-session-token"),
}));

import { NextRequest } from "next/server";
import { middleware } from "./middleware";

function makeRequest(
  path: string,
  options?: { authHeader?: string; cookie?: string },
): NextRequest {
  const url = `http://localhost:3100${path}`;
  const headers = new Headers();
  if (options?.authHeader) {
    headers.set("authorization", options.authHeader);
  }
  if (options?.cookie) {
    headers.set("cookie", `skynet-api-key=${options.cookie}`);
  }
  return new NextRequest(url, { headers });
}

describe("middleware auth enforcement", () => {
  const originalEnv = process.env.SKYNET_DASHBOARD_API_KEY;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SKYNET_DASHBOARD_API_KEY = "test-api-key";
    process.env.NODE_ENV = "production";
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.SKYNET_DASHBOARD_API_KEY = originalEnv;
    } else {
      delete process.env.SKYNET_DASHBOARD_API_KEY;
    }
    process.env.NODE_ENV = originalNodeEnv;
  });

  // ── No API key configured ──────────────────────────────────────────
  describe("when SKYNET_DASHBOARD_API_KEY is not set", () => {
    beforeEach(() => {
      delete process.env.SKYNET_DASHBOARD_API_KEY;
    });

    it("returns 500 JSON for API routes in production", async () => {
      const res = await middleware(makeRequest("/api/some-endpoint"));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ data: null, error: "Auth not configured" });
    });

    it("returns 500 plain text for page routes in production", async () => {
      const res = await middleware(makeRequest("/dashboard"));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("SKYNET_DASHBOARD_API_KEY not set");
    });

    it("allows all requests in development mode", async () => {
      process.env.NODE_ENV = "development";
      const res = await middleware(makeRequest("/dashboard"));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("allows API requests in development mode", async () => {
      process.env.NODE_ENV = "development";
      const res = await middleware(makeRequest("/api/data"));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });
  });

  // ── Public routes bypass auth ──────────────────────────────────────
  describe("public routes bypass auth", () => {
    it("allows /login without auth", async () => {
      const res = await middleware(makeRequest("/login"));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("allows /healthz without auth", async () => {
      const res = await middleware(makeRequest("/healthz"));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("allows /api/auth/login without auth", async () => {
      const res = await middleware(makeRequest("/api/auth/login"));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("allows /api/auth/logout without auth", async () => {
      const res = await middleware(makeRequest("/api/auth/logout"));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("allows /_next/static assets without auth", async () => {
      const res = await middleware(makeRequest("/_next/static/chunks/main.js"));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("allows /_next/image without auth", async () => {
      const res = await middleware(makeRequest("/_next/image?url=test.png"));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });
  });

  // ── Valid authentication ───────────────────────────────────────────
  describe("valid authentication", () => {
    it("allows request with raw API key in Authorization header", async () => {
      const res = await middleware(
        makeRequest("/api/data", { authHeader: "Bearer test-api-key" }),
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("allows request with session token in Authorization header", async () => {
      const res = await middleware(
        makeRequest("/api/data", { authHeader: "Bearer mock-session-token" }),
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("allows request with raw API key in cookie", async () => {
      const res = await middleware(
        makeRequest("/api/data", { cookie: "test-api-key" }),
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("allows request with session token in cookie", async () => {
      const res = await middleware(
        makeRequest("/api/data", { cookie: "mock-session-token" }),
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("allows page access with valid Bearer token", async () => {
      const res = await middleware(
        makeRequest("/dashboard", { authHeader: "Bearer test-api-key" }),
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("allows page access with valid cookie", async () => {
      const res = await middleware(
        makeRequest("/settings", { cookie: "test-api-key" }),
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });
  });

  // ── Invalid or missing authentication ──────────────────────────────
  describe("invalid or missing authentication", () => {
    it("returns 401 JSON for API route with no credentials", async () => {
      const res = await middleware(makeRequest("/api/data"));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ data: null, error: "Unauthorized" });
    });

    it("redirects to /login for page route with no credentials", async () => {
      const res = await middleware(makeRequest("/dashboard"));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    });

    it("returns 401 JSON for API route with wrong token", async () => {
      const res = await middleware(
        makeRequest("/api/data", { authHeader: "Bearer wrong-token" }),
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ data: null, error: "Unauthorized" });
    });

    it("redirects to /login for page route with wrong token", async () => {
      const res = await middleware(
        makeRequest("/dashboard", { authHeader: "Bearer wrong-token" }),
      );
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    });

    it("returns 401 for API route with wrong cookie", async () => {
      const res = await middleware(
        makeRequest("/api/data", { cookie: "wrong-token" }),
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ data: null, error: "Unauthorized" });
    });

    it("redirects for page route with wrong cookie", async () => {
      const res = await middleware(
        makeRequest("/settings", { cookie: "wrong-token" }),
      );
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    });
  });

  // ── Token extraction and priority ──────────────────────────────────
  describe("token extraction", () => {
    it("strips Bearer prefix case-insensitively", async () => {
      const res = await middleware(
        makeRequest("/api/data", { authHeader: "bearer test-api-key" }),
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("strips BEARER (uppercase) prefix", async () => {
      const res = await middleware(
        makeRequest("/api/data", { authHeader: "BEARER test-api-key" }),
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("Authorization header takes priority over cookie", async () => {
      const res = await middleware(
        makeRequest("/api/data", {
          authHeader: "Bearer test-api-key",
          cookie: "wrong-token",
        }),
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("uses cookie when header has wrong token but cookie is valid", async () => {
      // When header value fails, the || fallback to cookie won't happen
      // because the header value is truthy (just wrong)
      const res = await middleware(
        makeRequest("/api/data", {
          authHeader: "Bearer wrong-token",
          cookie: "test-api-key",
        }),
      );
      // Header is tried first; it's truthy so cookie is never used
      expect(res.status).toBe(401);
    });

    it("falls back to cookie when Authorization header is absent", async () => {
      const res = await middleware(
        makeRequest("/api/data", { cookie: "test-api-key" }),
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });
  });

  // ── Matcher config ─────────────────────────────────────────────────
  describe("matcher config", () => {
    it("exports a matcher that excludes _next/static, _next/image, and favicon.ico", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { config } = await import("./middleware");
      expect(config.matcher).toEqual([
        "/((?!_next/static|_next/image|favicon.ico).*)",
      ]);
    });
  });
});
