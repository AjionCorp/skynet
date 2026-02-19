import { spawn } from "child_process";
import { openSync, readFileSync, writeFileSync, unlinkSync, constants } from "fs";
import { resolve } from "path";
import type { SkynetConfig } from "../types";

const SCALABLE_TYPES = ["dev-worker", "task-fixer", "project-driver"] as const;

type ScalableType = (typeof SCALABLE_TYPES)[number];

const TYPE_LABELS: Record<ScalableType, string> = {
  "dev-worker": "Dev Worker",
  "task-fixer": "Task Fixer",
  "project-driver": "Project Driver",
};

const TYPE_MAX: Record<ScalableType, number> = {
  "dev-worker": 4,
  "task-fixer": 3,
  "project-driver": 2,
};

function isScalable(t: string): t is ScalableType {
  return (SCALABLE_TYPES as readonly string[]).includes(t);
}

function maxForType(t: ScalableType, maxWorkers: number): number {
  if (t === "dev-worker") return maxWorkers;
  return TYPE_MAX[t];
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset a stale current-task file if it shows in_progress but no worker is running.
 * Without this, a newly spawned worker sees "in_progress" and exits immediately.
 */
function resetStaleTaskFile(devDir: string, workerType: ScalableType, slotId: number): void {
  // dev-worker uses per-worker files; task-fixer uses the shared current-task.md
  const taskFile =
    workerType === "dev-worker"
      ? resolve(devDir, `current-task-${slotId}.md`)
      : resolve(devDir, "current-task.md");
  try {
    const content = readFileSync(taskFile, "utf-8");
    if (content.includes("in_progress")) {
      writeFileSync(
        taskFile,
        `# Current Task\n**Status:** idle\n**Updated:** ${new Date().toISOString()}\n**Note:** Reset by scaling handler — previous worker exited\n`
      );
    }
  } catch {
    // File doesn't exist — nothing to reset
  }
}

function readPidFile(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf-8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function getRunning(
  lockPrefix: string,
  type: ScalableType,
  maxWorkers: number
): { id: number; pid: number; lockFile: string }[] {
  const out: { id: number; pid: number; lockFile: string }[] = [];
  const max = maxForType(type, maxWorkers);

  for (let i = 1; i <= max; i++) {
    // dev-worker uses numbered lock files; others check both unnumbered (id=1) and numbered
    const lockFile =
      type === "dev-worker"
        ? `${lockPrefix}-dev-worker-${i}.lock`
        : i === 1
          ? `${lockPrefix}-${type}.lock`
          : `${lockPrefix}-${type}-${i}.lock`;
    const pid = readPidFile(lockFile);
    if (pid !== null && isProcessAlive(pid)) {
      out.push({ id: i, pid, lockFile });
    }
  }

  return out;
}

/**
 * Create GET/POST handlers for the workers/scale endpoint.
 * GET: returns current counts and max counts per scalable worker type.
 * POST: accepts { workerType, count } to scale workers up or down.
 */
export function createWorkerScalingHandler(config: SkynetConfig) {
  const { lockPrefix, devDir } = config;
  const scriptsDir = config.scriptsDir ?? `${devDir}/scripts`;
  const maxWorkers = config.maxWorkers ?? 4;

  async function GET(): Promise<Response> {
    try {
      const workers = SCALABLE_TYPES.map((type) => {
        const max = maxForType(type, maxWorkers);
        const running = getRunning(lockPrefix, type, maxWorkers);
        return {
          type,
          label: TYPE_LABELS[type],
          count: running.length,
          maxCount: max,
          pids: running.map((r) => r.pid),
        };
      });
      return Response.json({ data: { workers }, error: null });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to get worker counts",
        },
        { status: 500 }
      );
    }
  }

  async function POST(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      const { workerType, count } = body as {
        workerType: string;
        count: number;
      };

      // Validate workerType (alphanumeric + hyphens only)
      if (
        !workerType ||
        !/^[a-z0-9-]+$/.test(workerType) ||
        !isScalable(workerType)
      ) {
        return Response.json(
          {
            data: null,
            error: `Invalid workerType. Allowed: ${SCALABLE_TYPES.join(", ")}`,
          },
          { status: 400 }
        );
      }

      const max = maxForType(workerType, maxWorkers);
      if (
        typeof count !== "number" ||
        !Number.isInteger(count) ||
        count < 0 ||
        count > max
      ) {
        return Response.json(
          {
            data: null,
            error: `count must be an integer between 0 and ${max}`,
          },
          { status: 400 }
        );
      }

      const running = getRunning(lockPrefix, workerType, maxWorkers);
      const currentCount = running.length;
      const delta = count - currentCount;

      if (delta > 0) {
        // Scale up — spawn new worker processes
        const usedIds = new Set(running.map((r) => r.id));
        // Logs go to devDir/scripts/ (e.g. .dev/scripts/), not the source scriptsDir
        const logDir = resolve(devDir, "scripts");

        for (let i = 0; i < delta; i++) {
          let newId = 1;
          while (usedIds.has(newId)) newId++;
          usedIds.add(newId);

          // Clear stale in_progress task file so the new worker doesn't bail out
          resetStaleTaskFile(devDir, workerType, newId);

          const scriptPath = resolve(scriptsDir, `${workerType}.sh`);
          // First instance of non-dev-worker uses unnumbered log; extras get numbered
          const logSuffix =
            workerType === "dev-worker"
              ? `dev-worker-${newId}`
              : newId === 1
                ? workerType
                : `${workerType}-${newId}`;
          const logPath = resolve(logDir, `${logSuffix}.log`);
          const logFd = openSync(
            logPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
          );
          // dev-worker expects worker ID as arg; others just get the script
          const args = workerType === "dev-worker"
            ? [scriptPath, String(newId)]
            : [scriptPath];
          // Always pass SKYNET_DEV_DIR so scripts can find config
          const child = spawn("bash", args, {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: { ...process.env, SKYNET_DEV_DIR: devDir },
          });
          child.unref();
        }
      } else if (delta < 0) {
        // Scale down — kill highest-numbered workers first, clean up PID + heartbeat files
        const toKill = [...running]
          .sort((a, b) => b.id - a.id)
          .slice(0, Math.abs(delta));

        for (const instance of toKill) {
          try {
            process.kill(instance.pid, "SIGTERM");
          } catch {
            // Process already dead
          }

          // Clean up PID lock file
          try {
            unlinkSync(instance.lockFile);
          } catch {
            // Already cleaned up by EXIT trap
          }

          // Clean up heartbeat file for dev-workers
          if (workerType === "dev-worker") {
            try {
              unlinkSync(
                resolve(devDir, `worker-${instance.id}.heartbeat`)
              );
            } catch {
              // Already cleaned up
            }
          }
        }
      }

      return Response.json({
        data: {
          workerType,
          previousCount: currentCount,
          currentCount: count,
          maxCount: max,
        },
        error: null,
      });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to scale workers",
        },
        { status: 500 }
      );
    }
  }

  return { GET, POST };
}
