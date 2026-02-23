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
export function deriveSessionToken(apiKey: string): string {
  return createHmac("sha256", apiKey).update("skynet-session").digest("hex");
}
