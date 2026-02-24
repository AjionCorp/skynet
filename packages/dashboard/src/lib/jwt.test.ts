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
});
