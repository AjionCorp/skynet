/**
 * Decode the `exp` field from a JWT without verifying the signature.
 * Returns the expiration timestamp in seconds, or null if decoding fails.
 */
export function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}
