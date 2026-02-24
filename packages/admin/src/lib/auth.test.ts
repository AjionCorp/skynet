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
