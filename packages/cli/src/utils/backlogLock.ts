import { mkdirSync, rmSync, statSync } from "fs";

/**
 * Acquire the backlog mutex lock using mkdir (atomic on all Unix).
 * Mirrors the shell pattern in scripts/dev-worker.sh.
 *
 * @returns true if lock acquired, false if timed out
 */
export function acquireBacklogLock(
  lockPath: string,
  retries = 50,
  intervalMs = 100,
): boolean {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      mkdirSync(lockPath);
      return true;
    } catch {
      // mkdir fails if dir already exists (EEXIST) — lock is held
    }

    // On last attempt, check for stale lock (older than 30s)
    if (attempt === retries - 1) {
      try {
        const stat = statSync(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 30_000) {
          rmSync(lockPath, { recursive: true, force: true });
          try {
            mkdirSync(lockPath);
            return true;
          } catch {
            // Another process grabbed it
          }
        }
      } catch {
        // Lock dir gone — retry once
        try {
          mkdirSync(lockPath);
          return true;
        } catch {
          // Lost the race
        }
      }
      return false;
    }

    // Busy-wait (sync sleep via Atomics for sub-second precision)
    const buf = new SharedArrayBuffer(4);
    const arr = new Int32Array(buf);
    Atomics.wait(arr, 0, 0, intervalMs);
  }
  return false;
}

/**
 * Release the backlog mutex lock.
 * Mirrors: rmdir "$BACKLOG_LOCK" || rm -rf "$BACKLOG_LOCK"
 */
export function releaseBacklogLock(lockPath: string): void {
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}
