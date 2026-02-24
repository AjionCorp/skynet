import { timingSafeEqual, createHmac, randomBytes } from "crypto";

// TS-P3-1: Per-process random HMAC key instead of hardcoded string.
// Regenerated on each process start — only needs to be consistent within a
// single comparison call (both HMACs use the same key).
const CMP_KEY = randomBytes(32);

/**
 * Timing-safe string comparison to prevent timing attacks on API key validation.
 * Uses HMAC to normalize both inputs to fixed-length digests (32 bytes) before
 * comparing, which eliminates the length oracle that a naive length check leaks.
 */
export function safeCompare(a: string, b: string): boolean {
  const ha = createHmac("sha256", CMP_KEY).update(a).digest();
  const hb = createHmac("sha256", CMP_KEY).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Derive a deterministic session token from the API key using HMAC.
 * This avoids storing the raw API key in cookies while remaining stateless —
 * the same API key always produces the same token, so verification just
 * recomputes the HMAC and compares.
 *
 * SECURITY NOTE: The session token is deterministic from the API key and
 * cannot be revoked without rotating the SKYNET_DASHBOARD_API_KEY itself.
 * The 7-day cookie maxAge controls browser-side expiry only — a captured
 * token remains valid server-side until the API key is changed.
 * Additionally, in development mode the cookie is set with `secure: false`,
 * which means tokens can be intercepted over plain HTTP connections.
 * For production, always deploy behind HTTPS.
 */
// Session tokens are deterministic (HMAC of API key) — they are permanent until
// the API key changes. The 7-day cookie maxAge controls browser-side expiry only.
// For rotation, change the SKYNET_API_KEY in the environment.
export function deriveSessionToken(apiKey: string): string {
  return createHmac("sha256", apiKey).update("skynet-session").digest("hex");
}
