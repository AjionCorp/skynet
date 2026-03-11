import type { SkynetConfig, ProjectDriverTelemetry } from "../types";
import * as fs from "fs";
import * as path from "path";
import { readDevFile, getLastLogLine, extractTimestamp } from "../lib/file-reader";
import { getWorkerStatus } from "../lib/worker-status";
import { logHandlerError } from "../lib/handler-error";
import { listProjectDriverLocks } from "../lib/process-locks";

function getProjectDriverLogName(lockPrefix: string, lockPath: string): string {
  const globalLock = `${lockPrefix}-project-driver-global.lock`;
  if (lockPath === globalLock) {
    return "project-driver-global";
  }

  const legacyLock = `${lockPrefix}-project-driver.lock`;
 
  if (lockPath === globalLock) {
    return "project-driver-global";
  }

  const prefix = `${lockPrefix}-project-driver-`;
  if (!lockPath.startsWith(prefix) || !lockPath.endsWith(".lock")) {
    return "project-driver-global";
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
          : [`${lockPrefix}-project-driver-global.lock`];
      const statuses = lockCandidates.map((lockFile) => ({
        lockFile,
        ...getWorkerStatus(lockFile),
      }));
      const activeLock = statuses.find((status) => status.running) ?? statuses[0];
      const { pid, ageMs } = activeLock;

      // Last log line
      const logScript = getProjectDriverLogName(lockPrefix, activeLock.lockFile);
      const lastLog =
        getLastLogLine(devDir, logScript) ??
        (logScript !== "project-driver" ? getLastLogLine(devDir, "project-driver") : null);
      const lastLogTime = extractTimestamp(lastLog);

      // Try to parse Project Driver Learnings from scripts/project-driver.sh
      let learnings: string | null = null;
      try {
        const scriptPath = path.resolve(devDir, "../scripts/project-driver.sh");
        if (fs.existsSync(scriptPath)) {
          const content = fs.readFileSync(scriptPath, "utf-8");
          const learningsMatch = content.match(/## PROJECT DRIVER LEARNINGS\n([\s\S]*?)\n"/);
          if (learningsMatch && learningsMatch[1]) {
            learnings = learningsMatch[1].trim();
            // If it's just the default placeholder, don't show it
            if (learnings === "(Append specific, contextual lessons here to improve future task generation)") {
              learnings = null;
            }
          }
        }
      } catch {
        // Ignore file read errors
      }

      // Telemetry snapshot (may not exist)
      let telemetry: ProjectDriverTelemetry | null = null;
      const telemetryRaw = readDevFile(devDir, "project-driver-telemetry.json");
      if (telemetryRaw) {
        try {
          telemetry = JSON.parse(telemetryRaw) as ProjectDriverTelemetry;
          if (typeof telemetry.fixRate === "number" && telemetry.fixRate >= 0 && telemetry.fixRate <= 1) {
            telemetry = {
              ...telemetry,
              fixRate: Math.round(telemetry.fixRate * 100),
            };
          }
        } catch {
          // Malformed JSON — treat as missing
        }
      }

      return Response.json({
        data: {
          running: statuses.some((status) => status.running),
          pid,
          ageMs,
          lastLog,
          lastLogTime,
          telemetry,
          learnings,
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
