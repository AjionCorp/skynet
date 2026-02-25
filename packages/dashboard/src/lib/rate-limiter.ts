/**
 * In-memory sliding-window rate limiter.
 *
 * Decouples rate-limit writes from SkynetDB so that the database connection
 * can be opened in readonly mode for read-only consumers (GET handlers).
 *
 * Trade-offs vs. SQLite-backed rate limiting:
 *   - Resets on process restart (acceptable for a 60s window)
 *   - Per-process only (fine for single Next.js process)
 *   + No DB write contention
 *   + Allows readonly DB connections for all read-only handlers
 */

interface RateLimitWindow {
  timestamps: number[];
}

const windows = new Map<string, RateLimitWindow>();

/**
 * Check whether a rate limit key is within the allowed count for the window.
 * Returns true if the request is allowed, false if rate-limited.
 * On success, records the current timestamp.
 *
 * Uses a sliding window: timestamps older than `windowMs` are pruned on each
 * call. The array is bounded by `maxCount` (shift is O(n) but n <= maxCount,
 * typically 30).
 */
export function checkRateLimit(key: string, maxCount: number, windowMs: number): boolean {
  const now = Date.now();
  let window = windows.get(key);
  if (!window) {
    window = { timestamps: [] };
    windows.set(key, window);
  }

  // Purge expired timestamps
  const cutoff = now - windowMs;
  while (window.timestamps.length > 0 && window.timestamps[0] <= cutoff) {
    window.timestamps.shift();
  }

  if (window.timestamps.length >= maxCount) {
    return false;
  }

  window.timestamps.push(now);
  return true;
}

/** @internal — Reset all rate limit state. For tests only. */
export function _resetRateLimits(): void {
  windows.clear();
}
