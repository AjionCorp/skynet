import { appendFileSync, statSync, renameSync } from "fs";

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Log unexpected handler errors to a persistent file for structured debugging.
 * Writes one JSON line per error to {devDir}/dashboard-errors.log.
 * Rotates the log file when it exceeds 5MB.
 * Best-effort — never throws.
 */
export function logHandlerError(devDir: string | undefined, handler: string, err: unknown): void {
  if (!devDir) return;
  try {
    const logPath = `${devDir}/dashboard-errors.log`;

    // Rotate if log exceeds 5MB
    try {
      const stats = statSync(logPath);
      if (stats.size > MAX_LOG_SIZE) {
        renameSync(logPath, `${logPath}.1`);
      }
    } catch {
      // File may not exist yet — continue
    }

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      handler,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    appendFileSync(logPath, line + "\n");
  } catch {
    // Best-effort — do not throw if logging itself fails
  }
}
