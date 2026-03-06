import type { SkynetConfig, ProjectDriverTelemetry } from "../types";
import { readDevFile, getLastLogLine, extractTimestamp } from "../lib/file-reader";
import { getWorkerStatus } from "../lib/worker-status";
import { logHandlerError } from "../lib/handler-error";
import { listProjectDriverLocks } from "../lib/process-locks";
import { basename } from "path";

/**
 * Create a GET handler for the project-driver/status endpoint.
 * Returns project-driver running state, telemetry snapshot, and last log line.
 */
export function createProjectDriverStatusHandler(config: SkynetConfig) {
  const { devDir, lockPrefix } = config;

  return async function GET(): Promise<Response> {
    try {
      const discoveredLocks = listProjectDriverLocks(lockPrefix);
      const lockFiles = discoveredLocks.length > 0
        ? discoveredLocks
        : [`${lockPrefix}-project-driver-global.lock`, `${lockPrefix}-project-driver.lock`];
      const lockPrefixBase = `${basename(lockPrefix)}-`;
      const statuses = lockFiles.map((lockFile) => ({
        lockFile,
        ...getWorkerStatus(lockFile),
      }));
      const activeStatus = statuses.find((status) => status.running) ?? statuses[0];
      const processName = basename(activeStatus.lockFile)
        .replace(lockPrefixBase, "")
        .replace(/\.lock$/, "");

      const logCandidates = Array.from(
        new Set([processName, "project-driver-global", "project-driver"])
      );
      let lastLog: string | null = null;
      for (const logName of logCandidates) {
        lastLog = getLastLogLine(devDir, logName);
        if (lastLog) break;
      }
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
        data: {
          running: statuses.some((status) => status.running),
          pid: activeStatus.pid,
          ageMs: activeStatus.ageMs,
          lastLog,
          lastLogTime,
          telemetry,
        },
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
