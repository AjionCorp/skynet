import type { SkynetConfig, ProjectDriverTelemetry } from "../types";
import { readDevFile, getLastLogLine, extractTimestamp } from "../lib/file-reader";
import { getWorkerStatus } from "../lib/worker-status";

/**
 * Create a GET handler for the project-driver/status endpoint.
 * Returns project-driver running state, telemetry snapshot, and last log line.
 */
export function createProjectDriverStatusHandler(config: SkynetConfig) {
  const { devDir, lockPrefix } = config;

  return async function GET(): Promise<Response> {
    try {
      // Running status via PID lock
      const lockFile = `${lockPrefix}-project-driver.lock`;
      const { running, pid, ageMs } = getWorkerStatus(lockFile);

      // Last log line
      const lastLog = getLastLogLine(devDir, "project-driver");
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
