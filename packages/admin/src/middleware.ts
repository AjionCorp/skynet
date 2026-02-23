import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { safeCompare, deriveSessionToken } from "./lib/auth";

export function middleware(request: NextRequest) {
  const apiKey = process.env.SKYNET_DASHBOARD_API_KEY;

  // No key configured: allow only in explicit dev mode, fail closed otherwise
  if (!apiKey) {
    if (process.env.NODE_ENV !== "development") {
      const { pathname } = request.nextUrl;
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { data: null, error: "Auth not configured" },
          { status: 500 }
        );
      }
      return new NextResponse("SKYNET_DASHBOARD_API_KEY not set", { status: 500 });
    }
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Login page and auth routes bypass auth
  if (
    pathname === "/login" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next")
  ) {
    return NextResponse.next();
  }

  // Check Authorization header (for API clients) or cookie (for browser)
  const authHeader = request.headers.get("authorization");
  const cookie = request.cookies.get("skynet-api-key");
  const token = authHeader?.replace("Bearer ", "") || cookie?.value;

  // Accepts both raw API key (for backward compatibility / CLI usage) and HMAC session token.
  // Prefer session token for browser-based access to avoid key exposure in logs.
  const expectedSessionToken = deriveSessionToken(apiKey);
  if (token && (safeCompare(token, apiKey) || safeCompare(token, expectedSessionToken))) {
    return NextResponse.next();
  }

  // API routes return 401 JSON
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { data: null, error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Pages redirect to login
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
