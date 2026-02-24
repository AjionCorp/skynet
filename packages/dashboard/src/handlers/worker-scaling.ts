import { spawn } from "child_process";
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, rmSync, existsSync, constants } from "fs";
import { resolve, join } from "path";
import type { SkynetConfig } from "../types";
import { parseBody } from "../lib/parse-body";
import { SAFE_SCRIPT_NAME } from "../lib/constants";

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
  "project-driver": 1,
};

function isScalable(t: string): t is ScalableType {
  return (SCALABLE_TYPES as readonly string[]).includes(t);
}

function maxForType(t: ScalableType, maxWorkers: number, maxFixers: number): number {
  if (t === "dev-worker") return maxWorkers;
  if (t === "task-fixer") return maxFixers;
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
 * Guards against clobbering a live worker by checking for its PID lock first.
 */
function resetStaleTaskFile(devDir: string, lockPrefix: string, workerType: ScalableType, slotId: number): void {
  // Only dev-worker uses per-worker current-task files that can block startup
  if (workerType !== "dev-worker") return;

  // Check if the worker's PID lock exists and its process is still running.
  // If so, do NOT reset — the worker is alive and owns this task file.
  const lockPath = `${lockPrefix}-dev-worker-${slotId}.lock`;
  const pid = readPidFile(lockPath);
  if (pid !== null && isProcessAlive(pid)) {
    return; // Worker is alive — don't clobber its task file
  }

  const taskFile = resolve(devDir, `current-task-${slotId}.md`);
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

function readPidFile(lockPath: string): number | null {
  try {
    // Support dir-based locks (lockPath/pid) and legacy file-based locks
    let content: string;
    try {
      content = readFileSync(join(lockPath, "pid"), "utf-8").trim();
    } catch {
      content = readFileSync(lockPath, "utf-8").trim();
    }
    const pid = Number(content);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function getRunning(
  lockPrefix: string,
  type: ScalableType,
  maxWorkers: number,
  maxFixers: number
): { id: number; pid: number; lockFile: string }[] {
  const out: { id: number; pid: number; lockFile: string }[] = [];
  const max = maxForType(type, maxWorkers, maxFixers);

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
  const maxFixers = config.maxFixers ?? 3;

  async function GET(): Promise<Response> {
    try {
      const workers = SCALABLE_TYPES.map((type) => {
        const max = maxForType(type, maxWorkers, maxFixers);
        const running = getRunning(lockPrefix, type, maxWorkers, maxFixers);
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
          error: process.env.NODE_ENV === "development"
            ? (err instanceof Error ? err.message : "Internal error")
            : "Internal server error",
        },
        { status: 500 }
      );
    }
  }

  async function POST(request: Request): Promise<Response> {
    try {
      const { data: body, error: parseError, status: parseStatus } = await parseBody<{
        workerType: string;
        count: number;
      }>(request);
      if (parseError || !body) {
        return Response.json({ data: null, error: parseError }, { status: parseStatus ?? 400 });
      }
      const { workerType, count } = body;

      // Validate workerType (alphanumeric + hyphens only)
      if (
        !workerType ||
        !SAFE_SCRIPT_NAME.test(workerType) ||
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

      const max = maxForType(workerType, maxWorkers, maxFixers);
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

      const running = getRunning(lockPrefix, workerType, maxWorkers, maxFixers);
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
          resetStaleTaskFile(devDir, lockPrefix, workerType, newId);

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
          try {
            // All worker types accept an instance ID as first arg
            const args = [scriptPath, String(newId)];
            // Always pass SKYNET_DEV_DIR so scripts can find config
            const child = spawn("bash", args, {
              detached: true,
              stdio: ["ignore", logFd, logFd],
              env: { ...process.env, SKYNET_DEV_DIR: devDir },
            });
            child.unref();
          } finally {
            closeSync(logFd);
          }
        }
      } else if (delta < 0) {
        // Scale down — kill highest-numbered workers first, clean up PID + heartbeat files
        const toKill = [...running]
          .sort((a, b) => b.id - a.id)
          .slice(0, Math.abs(delta));

        for (const instance of toKill) {
          // Check if the worker is currently holding the merge lock — refuse to
          // kill mid-merge to prevent leaving main in an inconsistent state.
          //
          // TOCTOU note: There is an inherent race window between this check and
          // the kill() call below — the worker could acquire the merge lock in
          // between. We narrow the window with a second check immediately before
          // kill, but cannot fully eliminate it without kernel-level atomic
          // check-and-kill. In practice the window is <1ms and the merge lock
          // acquisition itself takes longer (mkdir + PID write), making this
          // race extremely unlikely to trigger.
          const mergeLockDir = `${lockPrefix}-merge.lock`;
          const mergePidFile = `${mergeLockDir}/pid`;
          const isMerging = (): boolean => {
            if (!existsSync(mergeLockDir) || !existsSync(mergePidFile)) return false;
            try {
              return readFileSync(mergePidFile, "utf-8").trim() === String(instance.pid);
            } catch { return false; }
          };

          if (isMerging()) {
            return Response.json(
              { data: null, error: `Worker ${instance.id} is currently merging — cannot scale down safely. Try again shortly.` },
              { status: 409 }
            );
          }

          // Second check right before kill to narrow the TOCTOU window
          if (isMerging()) {
            return Response.json(
              { data: null, error: `Worker ${instance.id} acquired merge lock — cannot scale down safely. Try again shortly.` },
              { status: 409 }
            );
          }

          try {
            process.kill(instance.pid, "SIGTERM");
          } catch (err: unknown) {
            const killErr = err as NodeJS.ErrnoException;
            if (killErr.code === "ESRCH") {
              // Process already gone — expected, ignore
            } else {
              console.warn(`[worker-scaling] Unexpected error killing PID ${instance.pid}: ${killErr.message ?? String(err)}`);
            }
          }

          // Clean up lock directory (mkdir-based mutex)
          try {
            rmSync(instance.lockFile, { recursive: true, force: true });
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
          error: process.env.NODE_ENV === "development"
            ? (err instanceof Error ? err.message : "Internal error")
            : "Internal server error",
        },
        { status: 500 }
      );
    }
  }

  return { GET, POST };
}
