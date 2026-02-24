import { NextResponse } from "next/server";
import { safeCompare, deriveSessionToken } from "../../../../lib/auth";

// --- In-memory rate limiter for login attempts ---
// NOTE: Resets on process restart (Next.js dev mode, deployments, crashes).
// Acceptable for a single-operator dashboard. Persistent rate limiting would
// require external storage (Redis/DB) which is out of scope for this use case.
// The 5-attempt / 15-minute window provides sufficient protection against online brute-force.
const LOGIN_ATTEMPTS = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_TRACKED_IPS = 10_000; // prevent unbounded growth

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  // Periodic cleanup: if map exceeds MAX_TRACKED_IPS, purge expired entries
  if (LOGIN_ATTEMPTS.size > MAX_TRACKED_IPS) {
    for (const [key, entry] of LOGIN_ATTEMPTS) {
      if (now >= entry.resetAt) LOGIN_ATTEMPTS.delete(key);
    }
  }
  const entry = LOGIN_ATTEMPTS.get(ip);
  if (!entry || now >= entry.resetAt) {
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = LOGIN_ATTEMPTS.get(ip);
  if (!entry || now >= entry.resetAt) {
    LOGIN_ATTEMPTS.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

export async function POST(request: Request) {
  try {
    // Rate limit by both forwarded IP and connecting IP to prevent bypass via header spoofing.
    // In production behind a reverse proxy, x-real-ip is set by the proxy and cannot be spoofed.
    // WARNING: Without a trusted reverse proxy, both x-forwarded-for and x-real-ip can be
    // spoofed by the client. When deploying without a proxy, rate limiting falls back to
    // the "unknown" key, effectively sharing a single bucket for all unauthenticated clients.
    const forwardedIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
    const realIp = request.headers.get("x-real-ip")?.trim() || "";
    // Use the most trustworthy source: x-real-ip (set by reverse proxy), then x-forwarded-for, then "unknown"
    const ip = realIp || forwardedIp || "unknown";
    if (ip === "unknown") {
      console.warn("[auth/login] Rate limiting with ip='unknown' — no x-forwarded-for or x-real-ip header present. Deploy behind a reverse proxy for accurate per-IP rate limiting.");
    }
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { data: null, error: "Too many login attempts. Try again later." },
        { status: 429 }
      );
    }

    // Pre-check Content-Length header before reading body into memory
    const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
    if (contentLength > 10_000) {
      return NextResponse.json({ data: null, error: "Request body too large" }, { status: 413 });
    }
    const text = await request.text();
    if (text.length > 10_000) {
      return NextResponse.json({ data: null, error: "Request body too large" }, { status: 413 });
    }
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || typeof body.apiKey !== "string") {
      return NextResponse.json({ data: null, error: "Invalid request body" }, { status: 400 });
    }
    const { apiKey } = body as { apiKey: string };
    const expected = process.env.SKYNET_DASHBOARD_API_KEY;

    if (!expected) {
      return NextResponse.json(
        { data: null, error: "Authentication error" },
        { status: 500 }
      );
    }

    if (!apiKey || !safeCompare(apiKey, expected)) {
      recordFailedAttempt(ip);
      return NextResponse.json({ data: null, error: "Invalid API key" }, { status: 401 });
    }

    // Successful login — clear any accumulated failed attempts for this IP
    LOGIN_ATTEMPTS.delete(ip);

    const sessionToken = deriveSessionToken(expected);
    const response = NextResponse.json({ data: { ok: true }, error: null });
    response.cookies.set("skynet-api-key", sessionToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7, // 7 days — shorter expiry for better security
    });
    return response;
  } catch {
    return NextResponse.json({ data: null, error: "Invalid request" }, { status: 400 });
  }
}
