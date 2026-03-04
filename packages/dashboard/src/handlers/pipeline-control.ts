import { existsSync, writeFileSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { openSync, closeSync, constants } from "fs";
import { resolve } from "path";
import type { SkynetConfig } from "../types";
import { parseBody } from "../lib/parse-body";
import { readPid, isProcessAlive, killByLock, listProjectDriverLocks } from "../lib/process-locks";

/**
 * Pipeline control handler: pause, resume, start (watchdog), stop (pause + kill workers).
 * POST with { action: "pause" | "resume" | "start" | "stop" }
 */
export function createPipelineControlHandler(config: SkynetConfig) {
  const { devDir, lockPrefix } = config;
  const scriptsDir = config.scriptsDir ?? `${devDir}/scripts`;
  const pauseFile = resolve(devDir, "pipeline-paused");

  async function POST(request: Request): Promise<Response> {
    try {
      const { data: body, error: parseError } = await parseBody<{ action?: string }>(request);
      if (parseError || !body) {
        return Response.json({ data: null, error: parseError || "Invalid request body" }, { status: 400 });
      }
      const { action } = body;
      const VALID_ACTIONS = ["pause", "resume", "start", "stop"] as const;

      if (typeof action !== "string" || !VALID_ACTIONS.includes(action as typeof VALID_ACTIONS[number])) {
        return Response.json(
          { data: null, error: `Invalid or missing action. Must be one of: ${VALID_ACTIONS.join(", ")}` },
          { status: 400 },
        );
      }

      if (action === "pause") {
        if (existsSync(pauseFile)) {
          return Response.json({ data: { paused: true, alreadyPaused: true }, error: null });
        }
        writeFileSync(pauseFile, JSON.stringify({ pausedAt: new Date().toISOString(), pausedBy: "dashboard" }));
        return Response.json({ data: { paused: true }, error: null });
      }

      if (action === "resume") {
        if (!existsSync(pauseFile)) {
          return Response.json({ data: { resumed: true, alreadyRunning: true }, error: null });
        }
        unlinkSync(pauseFile);
        return Response.json({ data: { resumed: true }, error: null });
      }

      if (action === "start") {
        // Remove pause file if present
        if (existsSync(pauseFile)) {
          unlinkSync(pauseFile);
        }
        // Start watchdog if not running
        const watchdogLock = `${lockPrefix}-watchdog.lock`;
        const watchdogPid = readPid(watchdogLock);
        if (watchdogPid && isProcessAlive(watchdogPid)) {
          return Response.json({ data: { started: true, alreadyRunning: true }, error: null });
        }
        
        // Clean up stale lock if it exists but process is dead
        if (existsSync(watchdogLock)) {
          console.log(`[PipelineControl] Cleaning up stale watchdog lock: ${watchdogLock}`);
          try {
            const { rmSync } = require("fs") as typeof import("fs");
            rmSync(watchdogLock, { recursive: true, force: true });
          } catch (e) {
            console.error(`[PipelineControl] Failed to remove stale lock: ${e}`);
          }
        }

        const scriptPath = resolve(scriptsDir, "watchdog.sh");
        if (!existsSync(scriptPath)) {
          return Response.json({ data: null, error: "watchdog.sh not found" }, { status: 404 });
        }
        const logDir = resolve(devDir, "scripts");
        const logPath = resolve(logDir, "watchdog.log");
        console.log(`[PipelineControl] Starting watchdog: bash ${scriptPath} >> ${logPath}`);
        const logFd = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
        try {
          // Use nohup-like behavior: detached, stdio redirected to log, ignore SIGHUP
          const child = spawn("bash", [scriptPath], {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: { 
              ...process.env, 
              SKYNET_DEV_DIR: devDir,
              // Ensure we don't pass any parent-specific PIDs that might interfere
              _SKYNET_WATCHDOG_SPAWNED: "1"
            },
          });
          child.unref();
          console.log(`[PipelineControl] Watchdog spawned with PID: ${child.pid}`);
        } finally {
          closeSync(logFd);
        }
        return Response.json({ data: { started: true }, error: null });
      }

      if (action === "stop") {
        // Pause pipeline
        if (!existsSync(pauseFile)) {
          writeFileSync(pauseFile, JSON.stringify({ pausedAt: new Date().toISOString(), pausedBy: "dashboard" }));
        }
        // Kill all workers
        const killed: string[] = [];
        const maxWorkers = config.maxWorkers ?? 4;
        const maxFixers = config.maxFixers ?? 3;

        // Kill watchdog
        if (killByLock(`${lockPrefix}-watchdog.lock`)) killed.push("watchdog");

        // Kill dev-workers
        for (let i = 1; i <= maxWorkers; i++) {
          if (killByLock(`${lockPrefix}-dev-worker-${i}.lock`)) killed.push(`dev-worker-${i}`);
        }

        // Kill task-fixers
        if (killByLock(`${lockPrefix}-task-fixer.lock`)) killed.push("task-fixer-1");
        for (let i = 2; i <= maxFixers; i++) {
          if (killByLock(`${lockPrefix}-task-fixer-${i}.lock`)) killed.push(`task-fixer-${i}`);
        }

        // Kill project-driver(s)
        const pdLocks = listProjectDriverLocks(lockPrefix);
        if (pdLocks.length === 0) {
          if (killByLock(`${lockPrefix}-project-driver.lock`)) killed.push("project-driver");
        } else {
          for (const lockPath of pdLocks) {
            if (killByLock(lockPath)) {
              const name = lockPath.split("/").pop() || "project-driver";
              killed.push(name.replace(`${lockPrefix.split("/").pop()}-`, "").replace(/\.lock$/, ""));
            }
          }
        }

        return Response.json({ data: { stopped: true, killed }, error: null });
      }

      // Unreachable: VALID_ACTIONS check above covers all cases
      return Response.json({ data: null, error: "Unknown action" }, { status: 400 });
    } catch (err) {
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "Internal error" },
        { status: 500 },
      );
    }
  }

  return { POST };
}
