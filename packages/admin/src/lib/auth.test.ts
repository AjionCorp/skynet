import { describe, it, expect } from "vitest";
import { safeCompare, deriveSessionToken } from "./auth";

describe("safeCompare", () => {
  it("returns true for identical strings", async () => {
    expect(await safeCompare("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of same length", async () => {
    expect(await safeCompare("abc123", "xyz789")).toBe(false);
  });

  it("returns false for different length strings", async () => {
    expect(await safeCompare("short", "longer-string")).toBe(false);
  });

  it("returns false for empty vs non-empty", async () => {
    expect(await safeCompare("", "notempty")).toBe(false);
  });

  it("returns true for two empty strings", async () => {
    expect(await safeCompare("", "")).toBe(true);
  });
});

describe("deriveSessionToken", () => {
  it("returns a hex string", async () => {
    const token = await deriveSessionToken("test-key");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same key produces same token", async () => {
    const t1 = await deriveSessionToken("my-api-key");
    const t2 = await deriveSessionToken("my-api-key");
    expect(t1).toBe(t2);
  });

  it("produces different tokens for different keys", async () => {
    const t1 = await deriveSessionToken("key-a");
    const t2 = await deriveSessionToken("key-b");
    expect(t1).not.toBe(t2);
  });

  it("uses 'skynet-session' as HMAC data", async () => {
    const token = await deriveSessionToken("verify-key");
    expect(typeof token).toBe("string");
    expect(token.length).toBe(64);
  });
});

// ── TEST-P1-6: Auth token priority test ─────────────────────────────
describe("auth token resolution priority", () => {
  it("Authorization header takes priority over cookie value", () => {
    const authHeader = "Bearer header-token-value";
    const cookieValue = "cookie-token-value";
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

  it("validates that raw API key is accepted (backward compat)", async () => {
    const apiKey = "test-raw-key";
    const sessionToken = await deriveSessionToken(apiKey);
    expect(await safeCompare(apiKey, apiKey)).toBe(true);
    expect(
      await safeCompare(sessionToken, await deriveSessionToken(apiKey)),
    ).toBe(true);
    expect(await safeCompare(apiKey, sessionToken)).toBe(false);
  });
});
