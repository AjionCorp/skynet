import { timingSafeEqual, createHmac } from "crypto";

/**
 * Timing-safe string comparison to prevent timing attacks on API key validation.
 * Returns false immediately if lengths differ (leaks only length, not content).
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Derive a deterministic session token from the API key using HMAC.
 * This avoids storing the raw API key in cookies while remaining stateless —
 * the same API key always produces the same token, so verification just
 * recomputes the HMAC and compares.
 */
// Session tokens are deterministic (HMAC of API key) — they are permanent until
// the API key changes. The 30-day cookie maxAge controls browser-side expiry only.
// For rotation, change the SKYNET_API_KEY in the environment.
export function deriveSessionToken(apiKey: string): string {
  return createHmac("sha256", apiKey).update("skynet-session").digest("hex");
}
