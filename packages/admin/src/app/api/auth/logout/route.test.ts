import { describe, it, expect } from "vitest";
import { POST } from "./route";

describe("POST /api/auth/logout", () => {
  it("returns 200 with success response", async () => {
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ data: { ok: true }, error: null });
  });

  it("clears the skynet-api-key cookie with maxAge 0", async () => {
    const res = await POST();
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("skynet-api-key");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("sets httpOnly and sameSite=strict on the cleared cookie", async () => {
    const res = await POST();
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("HttpOnly");
    // Next.js lowercases SameSite value in the header
    expect(setCookie?.toLowerCase()).toContain("samesite=strict");
  });

  it("sets path=/ on the cleared cookie", async () => {
    const res = await POST();
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("Path=/");
  });

  it("does not set CORS headers", async () => {
    const res = await POST();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });
});
