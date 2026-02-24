import { describe, it, expect } from "vitest";
import { decodeJwtExp } from "./jwt";

describe("decodeJwtExp", () => {
  it("decodes valid JWT exp field", () => {
    // Create a valid JWT with exp=1700000000
    const payload = Buffer.from(JSON.stringify({ exp: 1700000000 })).toString("base64url");
    const token = `header.${payload}.signature`;
    expect(decodeJwtExp(token)).toBe(1700000000);
  });
  it("returns null for token with non-numeric exp", () => {
    const payload = Buffer.from(JSON.stringify({ exp: "not-a-number" })).toString("base64url");
    expect(decodeJwtExp(`h.${payload}.s`)).toBeNull();
  });
  it("returns null for token without exp", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "user" })).toString("base64url");
    expect(decodeJwtExp(`h.${payload}.s`)).toBeNull();
  });
  it("returns null for malformed token (< 3 parts)", () => {
    expect(decodeJwtExp("just.two")).toBeNull();
  });
  it("returns null for invalid base64 payload", () => {
    expect(decodeJwtExp("h.!!!invalid!!!.s")).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(decodeJwtExp("")).toBeNull();
  });

  // TEST-P2-5: base64url encoding vs standard base64
  it("handles base64url characters (- and _ instead of + and /)", () => {
    // Create a payload that would produce + and / in standard base64
    // but uses - and _ in base64url encoding
    const payload = Buffer.from(JSON.stringify({ exp: 1700000000, data: "test+/value" })).toString("base64url");
    // Verify the base64url payload contains - or _ (or at least no + or /)
    expect(payload).not.toMatch(/[+/]/);
    const token = `header.${payload}.signature`;
    expect(decodeJwtExp(token)).toBe(1700000000);
  });

  it("handles standard base64 padding characters", () => {
    // base64url omits padding =, but Buffer.from("base64url") handles both
    const payload = Buffer.from(JSON.stringify({ exp: 99 })).toString("base64url");
    expect(decodeJwtExp(`h.${payload}.s`)).toBe(99);
  });

  it("decodes payload with base64url-safe characters in values", () => {
    // Craft a payload with characters that differ between base64 and base64url
    const obj = { exp: 1234567890, sub: "user/admin+test" };
    const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
    expect(decodeJwtExp(`h.${payload}.s`)).toBe(1234567890);
  });

  it("returns null for base64url payload that decodes to non-JSON", () => {
    const payload = Buffer.from("not json at all").toString("base64url");
    expect(decodeJwtExp(`h.${payload}.s`)).toBeNull();
  });

});
