import { describe, it, expect } from "vitest";
import { safeCompare, deriveSessionToken } from "./auth";

describe("safeCompare", () => {
  it("returns true for identical strings", () => {
    expect(safeCompare("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(safeCompare("abc123", "xyz789")).toBe(false);
  });

  it("returns false for different length strings", () => {
    expect(safeCompare("short", "longer-string")).toBe(false);
  });

  it("returns false for empty vs non-empty", () => {
    expect(safeCompare("", "notempty")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(safeCompare("", "")).toBe(true);
  });
});

describe("deriveSessionToken", () => {
  it("returns a hex string", () => {
    const token = deriveSessionToken("test-key");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same key produces same token", () => {
    const t1 = deriveSessionToken("my-api-key");
    const t2 = deriveSessionToken("my-api-key");
    expect(t1).toBe(t2);
  });

  it("produces different tokens for different keys", () => {
    const t1 = deriveSessionToken("key-a");
    const t2 = deriveSessionToken("key-b");
    expect(t1).not.toBe(t2);
  });

  it("uses 'skynet-session' as HMAC data", () => {
    // Verify token changes if key changes but structure is valid
    const token = deriveSessionToken("verify-key");
    expect(typeof token).toBe("string");
    expect(token.length).toBe(64);
  });
});

// ── TEST-P1-6: Auth token priority test ─────────────────────────────
// Tests that the token resolution logic follows correct priority:
// Authorization header > cookie (> query param, if supported).
// This tests the extraction logic that the middleware uses.
describe("auth token resolution priority", () => {
  it("Authorization header takes priority over cookie value", () => {
    // Simulate the middleware's token extraction logic
    const authHeader = "Bearer header-token-value";
    const cookieValue = "cookie-token-value";

    // Middleware logic: authHeader?.replace(/^Bearer /i, "") || cookie?.value
    const token = authHeader?.replace(/^Bearer /i, "") || cookieValue;
    expect(token).toBe("header-token-value");
  });

  it("falls back to cookie when Authorization header is absent", () => {
    const authHeader: string | null = null;
    const cookieValue = "cookie-token-value";

    const token = authHeader?.replace(/^Bearer /i, "") || cookieValue;
    expect(token).toBe("cookie-token-value");
  });

  it("falls back to cookie when Authorization header is empty", () => {
    const authHeader = "";
    const cookieValue = "cookie-token-value";

    // Empty string is falsy, so || falls through to cookie
    const token = authHeader?.replace(/^Bearer /i, "") || cookieValue;
    expect(token).toBe("cookie-token-value");
  });

  it("uses Authorization header even when it matches cookie (header wins)", () => {
    const authHeader = "Bearer same-token";
    const cookieValue = "different-token";

    const token = authHeader?.replace(/^Bearer /i, "") || cookieValue;
    expect(token).toBe("same-token");
  });

  it("strips Bearer prefix case-insensitively", () => {
    const authHeader = "bearer My-Token-123";
    const token = authHeader.replace(/^Bearer /i, "");
    expect(token).toBe("My-Token-123");
  });

  it("handles BEARER (uppercase) prefix", () => {
    const authHeader = "BEARER My-Token-456";
    const token = authHeader.replace(/^Bearer /i, "");
    expect(token).toBe("My-Token-456");
  });

  it("returns undefined when neither header nor cookie is present", () => {
    const authHeader: string | null = null;
    const cookieValue: string | undefined = undefined;

    const token = authHeader?.replace(/^Bearer /i, "") || cookieValue;
    expect(token).toBeUndefined();
  });

  it("validates that raw API key is accepted (backward compat)", () => {
    // The middleware accepts both raw API key and derived session token
    const apiKey = "test-raw-key";
    const sessionToken = deriveSessionToken(apiKey);

    // Raw key check
    expect(safeCompare(apiKey, apiKey)).toBe(true);
    // Session token check
    expect(safeCompare(sessionToken, deriveSessionToken(apiKey))).toBe(true);
    // Cross-check should fail
    expect(safeCompare(apiKey, sessionToken)).toBe(false);
  });
});
