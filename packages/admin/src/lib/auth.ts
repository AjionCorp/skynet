// Edge Runtime compatible — uses Web Crypto API instead of Node.js crypto.

// TS-P3-1: Per-process random HMAC key instead of hardcoded string.
// Regenerated on each process start — only needs to be consistent within a
// single comparison call (both HMACs use the same key).
const CMP_KEY = crypto.getRandomValues(new Uint8Array(32));

async function hmacSha256(
  key: Uint8Array | string,
  data: string,
): Promise<ArrayBuffer> {
  const keyBytes =
    typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const dataBytes = new TextEncoder().encode(data);
  return crypto.subtle.sign("HMAC", cryptoKey, dataBytes.buffer as ArrayBuffer);
}

function bufEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  if (va.length !== vb.length) return false;
  // Constant-time comparison
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Timing-safe string comparison to prevent timing attacks on API key validation.
 * Uses HMAC to normalize both inputs to fixed-length digests (32 bytes) before
 * comparing, which eliminates the length oracle that a naive length check leaks.
 */
export async function safeCompare(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    hmacSha256(CMP_KEY, a),
    hmacSha256(CMP_KEY, b),
  ]);
  return bufEqual(ha, hb);
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
export async function deriveSessionToken(apiKey: string): Promise<string> {
  const buf = await hmacSha256(apiKey, "skynet-session");
  return bufToHex(buf);
}
