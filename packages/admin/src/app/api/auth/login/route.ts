import { NextResponse } from "next/server";
import { safeCompare, deriveSessionToken } from "../../../../lib/auth";

// --- In-memory rate limiter for login attempts ---
const LOGIN_ATTEMPTS = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = LOGIN_ATTEMPTS.get(ip);
  if (!entry || now >= entry.resetAt) {
    LOGIN_ATTEMPTS.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(request: Request) {
  try {
    // Rate limit by IP (X-Forwarded-For behind reverse proxy, fallback to "unknown")
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many login attempts. Try again later." },
        { status: 429 }
      );
    }

    // Pre-check Content-Length header before reading body into memory
    const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
    if (contentLength > 10_000) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    const text = await request.text();
    if (text.length > 10_000) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || typeof body.apiKey !== "string") {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const { apiKey } = body as { apiKey: string };
    const expected = process.env.SKYNET_DASHBOARD_API_KEY;

    if (!expected) {
      return NextResponse.json(
        { error: "Authentication error" },
        { status: 500 }
      );
    }

    if (!apiKey || !safeCompare(apiKey, expected)) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }

    const sessionToken = deriveSessionToken(expected);
    const response = NextResponse.json({ ok: true });
    response.cookies.set("skynet-api-key", sessionToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
