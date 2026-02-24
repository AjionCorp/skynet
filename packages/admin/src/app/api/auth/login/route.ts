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
// TS-P3-4: Lowered from 10000 to 1000 — cleanup should trigger sooner
const MAX_TRACKED_IPS = 1_000; // prevent unbounded growth

// TS-P1-2: Exported for testing — allows tests to inspect/clear internal state
export { LOGIN_ATTEMPTS as _LOGIN_ATTEMPTS_FOR_TESTING };

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  // TS-P1-2: Deterministic eviction when map exceeds threshold.
  // Step 1: purge all expired entries.
  // Step 2: if still over limit, evict oldest entries by resetAt.
  // Also run probabilistic cleanup (1 in 10) to keep the map trimmed generally.
  if (LOGIN_ATTEMPTS.size > MAX_TRACKED_IPS || (LOGIN_ATTEMPTS.size > 0 && Math.random() < 0.1)) {
    // Step 1: Remove all expired entries
    for (const [key, entry] of LOGIN_ATTEMPTS) {
      if (now >= entry.resetAt) LOGIN_ATTEMPTS.delete(key);
    }
    // Step 2: If still over limit after purging expired, evict oldest entries
    if (LOGIN_ATTEMPTS.size > MAX_TRACKED_IPS) {
      const entries = Array.from(LOGIN_ATTEMPTS.entries())
        .sort((a, b) => a[1].resetAt - b[1].resetAt);
      const toRemove = LOGIN_ATTEMPTS.size - MAX_TRACKED_IPS;
      for (let i = 0; i < toRemove; i++) {
        LOGIN_ATTEMPTS.delete(entries[i][0]);
      }
    }
  }
  const entry = LOGIN_ATTEMPTS.get(ip);
  if (!entry || now >= entry.resetAt) {
    // Expired entry — delete to prevent unbounded map growth
    if (entry) LOGIN_ATTEMPTS.delete(ip);
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
    const realIp = request.headers.get("x-real-ip")?.trim() || "";
    // TS-P1-1: Only trust x-forwarded-for when SKYNET_TRUST_PROXY is explicitly set to "true".
    // Without a trusted reverse proxy, x-forwarded-for can be spoofed by the client to bypass
    // per-IP rate limiting. x-real-ip is set by the reverse proxy itself and is harder to spoof,
    // but still requires proxy trust. When neither proxy header is available, rate limiting uses
    // a shared "unknown" bucket (less precise but safe from IP spoofing).
    const trustProxy = process.env.SKYNET_TRUST_PROXY === "true";
    const forwardedIp = trustProxy
      ? (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "")
      : "";
    // Use the most trustworthy source: x-real-ip (set by reverse proxy), then x-forwarded-for (if trusted), then "unknown"
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

    if (!apiKey || !(await safeCompare(apiKey, expected))) {
      recordFailedAttempt(ip);
      return NextResponse.json({ data: null, error: "Invalid API key" }, { status: 401 });
    }

    // Successful login — clear any accumulated failed attempts for this IP
    LOGIN_ATTEMPTS.delete(ip);

    const sessionToken = await deriveSessionToken(expected);
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
