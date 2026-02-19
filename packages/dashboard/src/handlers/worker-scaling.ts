import { spawn } from "child_process";
import { openSync, readFileSync, unlinkSync, constants } from "fs";
import { resolve } from "path";
import type { SkynetConfig } from "../types";

const SCALABLE_TYPES = ["dev-worker", "task-fixer", "project-driver"] as const;

type ScalableType = (typeof SCALABLE_TYPES)[number];

const TYPE_LABELS: Record<ScalableType, string> = {
  "dev-worker": "Dev Worker",
  "task-fixer": "Task Fixer",
  "project-driver": "Project Driver",
};

function isScalable(t: string): t is ScalableType {
  return (SCALABLE_TYPES as readonly string[]).includes(t);
}

function maxForType(t: ScalableType, maxWorkers: number): number {
  return t === "dev-worker" ? maxWorkers : 1;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

  if (type === "dev-worker") {
    for (let i = 1; i <= maxWorkers; i++) {
      const lockFile = `${lockPrefix}-dev-worker-${i}.lock`;
      const pid = readPidFile(lockFile);
      if (pid !== null && isProcessAlive(pid)) {
        out.push({ id: i, pid, lockFile });
      }
    }
  } else {
    const lockFile = `${lockPrefix}-${type}.lock`;
    const pid = readPidFile(lockFile);
    if (pid !== null && isProcessAlive(pid)) {
      out.push({ id: 1, pid, lockFile });
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

        for (let i = 0; i < delta; i++) {
          if (workerType === "dev-worker") {
            let newId = 1;
            while (usedIds.has(newId)) newId++;
            usedIds.add(newId);

            const scriptPath = resolve(scriptsDir, "dev-worker.sh");
            const logPath = resolve(scriptsDir, `dev-worker-${newId}.log`);
            const logFd = openSync(
              logPath,
              constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
            );
            const child = spawn("bash", [scriptPath, String(newId)], {
              detached: true,
              stdio: ["ignore", logFd, logFd],
            });
            child.unref();
          } else {
            const scriptPath = resolve(scriptsDir, `${workerType}.sh`);
            const logPath = resolve(scriptsDir, `${workerType}.log`);
            const logFd = openSync(
              logPath,
              constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
            );
            const child = spawn("bash", [scriptPath], {
              detached: true,
              stdio: ["ignore", logFd, logFd],
            });
            child.unref();
          }
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
