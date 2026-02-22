import { timingSafeEqual } from "crypto";

/**
 * Timing-safe string comparison to prevent timing attacks on API key validation.
 * Returns false immediately if lengths differ (leaks only length, not content).
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
