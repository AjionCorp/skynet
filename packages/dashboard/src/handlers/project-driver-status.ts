import type { SkynetConfig, ProjectDriverTelemetry } from "../types";
import { readDevFile, getLastLogLine, extractTimestamp } from "../lib/file-reader";
import { getWorkerStatus } from "../lib/worker-status";
import { logHandlerError } from "../lib/handler-error";
import { listProjectDriverLocks } from "../lib/process-locks";

function getProjectDriverLogName(lockPrefix: string, lockPath: string): string {
  const legacyLock = `${lockPrefix}-project-driver.lock`;
  if (lockPath === legacyLock) {
    return "project-driver";
  }

  const prefix = `${lockPrefix}-project-driver-`;
  if (!lockPath.startsWith(prefix) || !lockPath.endsWith(".lock")) {
    return "project-driver";
  }

  return `project-driver-${lockPath.slice(prefix.length, -".lock".length)}`;
}

/**
 * Create a GET handler for the project-driver/status endpoint.
 * Returns project-driver running state, telemetry snapshot, and last log line.
 */
export function createProjectDriverStatusHandler(config: SkynetConfig) {
  const { devDir, lockPrefix } = config;

  return async function GET(): Promise<Response> {
    try {
      // Running status via PID lock
      const discoveredLocks = listProjectDriverLocks(lockPrefix);
      const lockCandidates =
        discoveredLocks.length > 0
          ? discoveredLocks
          : [`${lockPrefix}-project-driver.lock`];
      const statuses = lockCandidates.map((lockFile) => ({
        lockFile,
        ...getWorkerStatus(lockFile),
      }));
      const activeLock = statuses.find((status) => status.running) ?? statuses[0];
      const { running, pid, ageMs } = activeLock;

      // Last log line
      const logScript = getProjectDriverLogName(lockPrefix, activeLock.lockFile);
      const lastLog =
        getLastLogLine(devDir, logScript) ??
        (logScript !== "project-driver" ? getLastLogLine(devDir, "project-driver") : null);
      const lastLogTime = extractTimestamp(lastLog);

      // Telemetry snapshot (may not exist)
      let telemetry: ProjectDriverTelemetry | null = null;
      const telemetryRaw = readDevFile(devDir, "project-driver-telemetry.json");
      if (telemetryRaw) {
        try {
          telemetry = JSON.parse(telemetryRaw) as ProjectDriverTelemetry;
        } catch {
          // Malformed JSON — treat as missing
        }
      }

      return Response.json({
        data: { running, pid, ageMs, lastLog, lastLogTime, telemetry },
        error: null,
      });
    } catch (err) {
      logHandlerError(config.devDir, "project-driver-status", err);
      return Response.json(
        {
          data: null,
          error: process.env.NODE_ENV === "development"
            ? (err instanceof Error ? err.message : "Internal error")
            : "Internal server error",
        },
        { status: 500 }
      );
    }
  };
}
