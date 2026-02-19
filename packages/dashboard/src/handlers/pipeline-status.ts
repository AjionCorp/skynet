import type { SkynetConfig } from "../types";
import { readDevFile, getLastLogLine, extractTimestamp } from "../lib/file-reader";
import { getWorkerStatus } from "../lib/worker-status";

/**
 * Parse current-task.md into a structured object.
 */
function parseCurrentTask(raw: string) {
  const statusMatch = raw.match(/\*\*Status:\*\* (\w+)/);
  const titleMatch = raw.match(/^## (.+)/m);
  const branchMatch = raw.match(/\*\*Branch:\*\* (.+)/);
  const startedMatch = raw.match(/\*\*Started:\*\* (.+)/);
  const workerMatch = raw.match(/\*\*Worker:\*\* (.+)/);
  const lastMatch = raw.match(/\*\*(?:Last.*|Note):\*\* (.+)/);

  return {
    status: statusMatch?.[1] ?? "unknown",
    title: titleMatch?.[1] ?? null,
    branch: branchMatch?.[1] ?? null,
    started: startedMatch?.[1] ?? null,
    worker: workerMatch?.[1] ?? null,
    lastInfo: lastMatch?.[1] ?? null,
  };
}

/**
 * Extract the task title from raw text (strip tag prefix and description/metadata suffixes).
 */
function extractTitle(text: string): string {
  const withoutMeta = text.replace(/\s*\|\s*blockedBy:\s*.+$/i, "");
  const withoutTag = withoutMeta.replace(/^\[[^\]]+\]\s*/, "");
  const dashIdx = withoutTag.indexOf(" \u2014 ");
  return (dashIdx >= 0 ? withoutTag.slice(0, dashIdx) : withoutTag).trim();
}

/**
 * Parse blockedBy metadata from raw text.
 */
function parseBlockedBy(text: string): string[] {
  const match = text.match(/\s*\|\s*blockedBy:\s*(.+)$/i);
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse a human-readable duration string (e.g., "23m", "1h 12m") into minutes.
 * Returns null if the string cannot be parsed.
 */
function parseDurationMinutes(s: string): number | null {
  const hm = s.match(/^(\d+)h\s+(\d+)m$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const hOnly = s.match(/^(\d+)h$/);
  if (hOnly) return Number(hOnly[1]) * 60;
  const mOnly = s.match(/^(\d+)m$/);
  if (mOnly) return Number(mOnly[1]);
  return null;
}

/**
 * Format minutes as a human-readable duration string (e.g., "23m", "1h 12m").
 */
function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const rem = Math.round(minutes % 60);
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/**
 * Parse backlog.md into items with status/tag/dependency info.
 */
function parseBacklog(raw: string) {
  const lines = raw.split("\n");
  const rawItems: { text: string; tag: string; status: "pending" | "claimed" | "done"; blockedBy: string[] }[] = [];
  let pendingCount = 0;
  let claimedCount = 0;
  let doneCount = 0;

  for (const line of lines) {
    let status: "pending" | "claimed" | "done" | null = null;
    let text = "";
    if (line.startsWith("- [ ] ")) {
      status = "pending";
      text = line.replace("- [ ] ", "");
      pendingCount++;
    } else if (line.startsWith("- [>] ")) {
      status = "claimed";
      text = line.replace("- [>] ", "");
      claimedCount++;
    } else if (line.startsWith("- [x] ")) {
      status = "done";
      text = line.replace("- [x] ", "");
      doneCount++;
    }
    if (status === null) continue;

    const tagMatch = text.match(/^\[([^\]]+)\]/);
    rawItems.push({ text, tag: tagMatch?.[1] ?? "", status, blockedBy: parseBlockedBy(text) });
  }

  // Resolve blocked status
  const titleToStatus = new Map<string, string>();
  for (const item of rawItems) {
    titleToStatus.set(extractTitle(item.text), item.status);
  }
  const items = rawItems.map((item) => ({
    ...item,
    blocked: item.blockedBy.length > 0 && item.blockedBy.some((dep) => titleToStatus.get(dep) !== "done"),
  }));

  return { items, pendingCount, claimedCount, doneCount };
}

/**
 * Calculate a pipeline health score (0–100).
 * Starts at 100 and deducts for issues:
 *   -5 per pending failed task
 *  -10 per active blocker
 *   -2 per stale heartbeat
 *   -1 per task that has been in progress >24 hours
 */
function calculateHealthScore(opts: {
  failedPendingCount: number;
  blockerCount: number;
  staleHeartbeatCount: number;
  staleTasks24hCount: number;
}): number {
  let score = 100;
  score -= opts.failedPendingCount * 5;
  score -= opts.blockerCount * 10;
  score -= opts.staleHeartbeatCount * 2;
  score -= opts.staleTasks24hCount * 1;
  return Math.max(0, Math.min(100, score));
}

/**
 * Create a GET handler for the pipeline/status endpoint.
 * Returns full monitoring status including workers, tasks, backlog, sync health, auth, and git.
 */
export function createPipelineStatusHandler(config: SkynetConfig) {
  const { devDir, lockPrefix, workers: workerDefs } = config;
  const scriptsDir = config.scriptsDir ?? `${devDir}/scripts`;

  return async function GET(): Promise<Response> {
    try {
      // Worker statuses
      const workers = workerDefs.map((w) => {
        const lockFile = `${lockPrefix}-${w.name}.lock`;
        const status = getWorkerStatus(lockFile);
        const logName = w.logFile ?? w.name;
        const lastLog = getLastLogLine(devDir, logName);
        const lastLogTime = extractTimestamp(lastLog);
        return {
          ...w,
          category: w.category ?? ("core" as const),
          logFile: logName,
          ...status,
          lastLog,
          lastLogTime,
        };
      });

      // Current tasks (per-worker files)
      const maxW = config.maxWorkers ?? 4;
      const currentTasks: Record<string, ReturnType<typeof parseCurrentTask>> = {};
      // Try per-worker files first, fall back to legacy single file
      for (let wid = 1; wid <= maxW; wid++) {
        const raw = readDevFile(devDir, `current-task-${wid}.md`);
        if (raw) currentTasks[`worker-${wid}`] = parseCurrentTask(raw);
      }
      // Legacy single file fallback
      const currentTaskRaw = readDevFile(devDir, "current-task.md");
      const currentTask = parseCurrentTask(currentTaskRaw);
      if (Object.keys(currentTasks).length === 0 && currentTaskRaw) {
        currentTasks["worker-1"] = currentTask;
      }

      // Worker heartbeats — read .dev/worker-N.heartbeat epoch files
      const heartbeats: Record<string, { lastEpoch: number | null; ageMs: number | null; isStale: boolean }> = {};
      const staleThresholdMs = 45 * 60 * 1000; // matches SKYNET_STALE_MINUTES default
      for (let wid = 1; wid <= maxW; wid++) {
        const hbRaw = readDevFile(devDir, `worker-${wid}.heartbeat`).trim();
        if (hbRaw) {
          const epoch = Number(hbRaw);
          const ageMs = Date.now() - epoch * 1000;
          heartbeats[`worker-${wid}`] = {
            lastEpoch: epoch,
            ageMs,
            isStale: ageMs > staleThresholdMs,
          };
        } else {
          heartbeats[`worker-${wid}`] = { lastEpoch: null, ageMs: null, isStale: false };
        }
      }

      // Backlog
      const backlogRaw = readDevFile(devDir, "backlog.md");
      const backlog = parseBacklog(backlogRaw);

      // Completed
      const completedRaw = readDevFile(devDir, "completed.md");
      const completedLines = completedRaw
        .split("\n")
        .filter(
          (l) =>
            l.startsWith("|") &&
            !l.includes("Date") &&
            !l.includes("---")
        );
      const completed = completedLines.map((l) => {
        const parts = l.split("|").map((p) => p.trim());
        // New format: | Date | Task | Branch | Duration | Notes | (7 parts incl. leading/trailing empty)
        // Old format: | Date | Task | Branch | Notes | (6 parts)
        const hasDuration = parts.length >= 7;
        return {
          date: parts[1] ?? "",
          task: parts[2] ?? "",
          branch: parts[3] ?? "",
          duration: hasDuration ? (parts[4] ?? "") : "",
          notes: hasDuration ? (parts[5] ?? "") : (parts[4] ?? ""),
        };
      });

      // Compute average task duration from entries that have duration data
      const durationMinutes = completed
        .map((c) => parseDurationMinutes(c.duration))
        .filter((d): d is number => d !== null);
      const averageTaskDuration =
        durationMinutes.length > 0
          ? formatDuration(
              durationMinutes.reduce((a, b) => a + b, 0) / durationMinutes.length
            )
          : null;

      // Failed tasks
      const failedRaw = readDevFile(devDir, "failed-tasks.md");
      const failedLines = failedRaw
        .split("\n")
        .filter(
          (l) =>
            l.startsWith("|") &&
            !l.includes("Date") &&
            !l.includes("---")
        );
      const failed = failedLines.map((l) => {
        const parts = l.split("|").map((p) => p.trim());
        return {
          date: parts[1] ?? "",
          task: parts[2] ?? "",
          branch: parts[3] ?? "",
          error: parts[4] ?? "",
          attempts: parts[5] ?? "",
          status: parts[6] ?? "",
        };
      });

      // Blockers — only parse the ## Active section
      const blockersRaw = readDevFile(devDir, "blockers.md");
      const activeMatch = blockersRaw.match(/## Active\s*\n([\s\S]*?)(?:\n## |\n*$)/i);
      const activeSection = activeMatch?.[1]?.trim() ?? "";
      const hasBlockers =
        activeSection.length > 0 &&
        activeSection.toLowerCase() !== "none" &&
        !activeSection.includes("No active blockers");
      const blockerLines = hasBlockers
        ? activeSection.split("\n").filter((l) => l.startsWith("- "))
        : [];

      // Sync health (from sync-health.md)
      const syncRaw = readDevFile(devDir, "sync-health.md");
      const lastSyncMatch = syncRaw.match(/_Last run: (.+)_/);
      const syncEndpoints = syncRaw
        .split("\n")
        .filter(
          (l) =>
            l.startsWith("|") &&
            !l.includes("Endpoint") &&
            !l.includes("---")
        )
        .map((l) => {
          const parts = l.split("|").map((p) => p.trim());
          return {
            endpoint: parts[1] ?? "",
            lastRun: parts[2] ?? "",
            status: parts[3] ?? "",
            records: parts[4] ?? "",
            notes: parts[5] ?? "",
          };
        });

      // Auth status
      const { existsSync, readFileSync, statSync } = await import("fs");
      const tokenCachePath = config.authTokenCache ?? `${lockPrefix}claude-token`;
      const authFailPath = config.authFailFlag ?? `${lockPrefix}auth-failed`;

      const tokenCached = existsSync(tokenCachePath);
      let tokenCacheAgeMs: number | null = null;
      if (tokenCached) {
        try {
          tokenCacheAgeMs = Date.now() - statSync(tokenCachePath).mtimeMs;
        } catch {
          /* ignore */
        }
      }
      const authFailFlag = existsSync(authFailPath);
      let lastFailEpoch: number | null = null;
      if (authFailFlag) {
        try {
          lastFailEpoch = Number(
            readFileSync(authFailPath, "utf-8").trim()
          );
        } catch {
          /* ignore */
        }
      }

      // Backlog mutex
      const backlogLockPath = `${lockPrefix}backlog.lock`;
      const backlogLocked = existsSync(backlogLockPath);

      // Git status — run in project root (parent of devDir)
      const { execSync } = await import("child_process");
      const projectRoot = devDir.replace(/\/?\.dev\/?$/, "");
      let gitBranch = "unknown";
      let commitsAhead = 0;
      let dirtyFiles = 0;
      let lastGitCommit: string | null = null;
      try {
        gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
          encoding: "utf-8",
          timeout: 3000,
          cwd: projectRoot,
        }).trim();
        const aheadMatch = execSync(
          "git rev-list --count origin/main..HEAD 2>/dev/null || echo 0",
          { encoding: "utf-8", timeout: 3000, cwd: projectRoot }
        ).trim();
        commitsAhead = Number(aheadMatch) || 0;
        const dirtyOutput = execSync("git status --porcelain", {
          encoding: "utf-8",
          timeout: 3000,
          cwd: projectRoot,
        }).trim();
        dirtyFiles = dirtyOutput ? dirtyOutput.split("\n").length : 0;
        lastGitCommit =
          execSync('git log -1 --format="%H %s" 2>/dev/null', {
            encoding: "utf-8",
            timeout: 3000,
            cwd: projectRoot,
          }).trim() || null;
      } catch {
        /* ignore */
      }

      // Post-commit gate
      let postCommitLastResult: string | null = null;
      let postCommitLastCommit: string | null = null;
      let postCommitLastTime: string | null = null;
      try {
        const gateLog = getLastLogLine(devDir, "post-commit-gate");
        if (gateLog) {
          postCommitLastResult = /PASS/i.test(gateLog)
            ? "pass"
            : /FAIL/i.test(gateLog)
              ? "fail"
              : "unknown";
          postCommitLastTime = extractTimestamp(gateLog);
          const commitMatch = gateLog.match(/\b([0-9a-f]{7,40})\b/);
          postCommitLastCommit = commitMatch?.[1] ?? null;
        }
      } catch {
        /* ignore */
      }

      // Health score inputs
      const failedPendingCount = failed.filter((f) =>
        f.status.includes("pending")
      ).length;
      const staleHeartbeatCount = Object.values(heartbeats).filter(
        (hb) => hb.isStale
      ).length;
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      const staleTasks24hCount = Object.values(currentTasks).filter((t) => {
        if (!t.started) return false;
        const startedDate = new Date(t.started);
        return !isNaN(startedDate.getTime()) && Date.now() - startedDate.getTime() > twentyFourHoursMs;
      }).length;

      const healthScore = calculateHealthScore({
        failedPendingCount,
        blockerCount: blockerLines.length,
        staleHeartbeatCount,
        staleTasks24hCount,
      });

      return Response.json({
        data: {
          workers,
          currentTask,
          currentTasks,
          heartbeats,
          backlog,
          completed,
          completedCount: completed.length,
          averageTaskDuration,
          failed,
          failedPendingCount,
          hasBlockers,
          blockerLines,
          healthScore,
          syncHealth: {
            lastRun: lastSyncMatch?.[1] ?? null,
            endpoints: syncEndpoints,
          },
          auth: {
            tokenCached,
            tokenCacheAgeMs,
            authFailFlag,
            lastFailEpoch,
          },
          backlogLocked,
          git: {
            branch: gitBranch,
            commitsAhead,
            dirtyFiles,
            lastCommit: lastGitCommit,
          },
          postCommitGate: {
            lastResult: postCommitLastResult,
            lastCommit: postCommitLastCommit,
            lastTime: postCommitLastTime,
          },
          timestamp: new Date().toISOString(),
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
              : "Failed to read pipeline status",
        },
        { status: 500 }
      );
    }
  };
}
