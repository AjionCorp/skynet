import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { dirname } from "path";
import { fileURLToPath } from "url";
import type { SkynetConfig, MissionProgress, CodexAuthStatus } from "../types";
import { readDevFile, getLastLogLine, extractTimestamp } from "../lib/file-reader";
import { STALE_THRESHOLD_SECONDS } from "../lib/constants";
import { getWorkerStatus } from "../lib/worker-status";
import { getSkynetDB } from "../lib/db";
import { parseBacklogWithBlocked } from "../lib/backlog-parser";
import { decodeJwtExp } from "../lib/jwt";

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
 * Parse a human-readable duration string (e.g., "23m", "1h 12m") into minutes.
 * Returns null if the string cannot be parsed.
 */
// NOTE: duration parsing also exists in packages/cli/src/commands/metrics.ts
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
  if (!Number.isFinite(minutes)) return "--";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const rem = Math.round(minutes % 60);
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}



function readCodexAuthStatus(
  readFile: (path: string, encoding: BufferEncoding) => string,
  authFile: string
): CodexAuthStatus {
  try {
    const raw = JSON.parse(readFile(authFile, "utf-8"));
    const tokens = raw?.tokens || {};
    const token = tokens.id_token || tokens.access_token || "";
    const refresh = tokens.refresh_token || "";
    if (!token) {
      return { status: "invalid", expiresInMs: null, hasRefreshToken: !!refresh, source: "invalid" };
    }
    const exp = decodeJwtExp(token);
    if (!exp) {
      return { status: "ok", expiresInMs: null, hasRefreshToken: !!refresh, source: "file" };
    }
    const remainingMs = exp * 1000 - Date.now();
    if (remainingMs <= 0) {
      return { status: "expired", expiresInMs: 0, hasRefreshToken: !!refresh, source: "file" };
    }
    return { status: "ok", expiresInMs: remainingMs, hasRefreshToken: !!refresh, source: "file" };
  } catch {
    return { status: "invalid", expiresInMs: null, hasRefreshToken: false, source: "invalid" };
  }
}

/**
 * Calculate a pipeline health score (0-100).
 * Starts at 100 and deducts for issues:
 *   -5 per pending failed task
 *  -10 per active blocker
 *   -2 per stale heartbeat
 *   -1 per task that has been in progress >24 hours
 *
 * Keep in sync with canonical formula in:
 *   - packages/dashboard/src/lib/db.ts (SkynetDB.calculateHealthScore)
 *   - packages/cli/src/commands/status.ts (healthScore calculation)
 *   - scripts/watchdog.sh (_health_score_alert)
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
 * Parse mission.md success criteria and evaluate each against current pipeline state.
 * Returns an array of MissionProgress items with status and evidence.
 */
function parseMissionProgress(opts: {
  devDir: string;
  completedCount: number;
  failedLines: { status: string }[];
  handlerCount: number;
}): MissionProgress[] {
  const { devDir, completedCount, failedLines, handlerCount } = opts;
  const missionRaw = readDevFile(devDir, "mission.md");
  if (!missionRaw) return [];

  // Extract numbered criteria under ## Success Criteria
  const scMatch = missionRaw.match(/## Success Criteria\s*\n([\s\S]*?)(?:\n## |\n*$)/i);
  if (!scMatch) return [];

  const criteriaLines = scMatch[1]
    .split("\n")
    .filter((l) => /^\d+\.\s/.test(l.trim()));

  const progress: MissionProgress[] = [];

  for (const line of criteriaLines) {
    const numMatch = line.trim().match(/^(\d+)\.\s+(.+)/);
    if (!numMatch) continue;
    const id = Number(numMatch[1]);
    const criterion = numMatch[2];

    const evaluated = evaluateCriterion(id, criterion, {
      devDir,
      completedCount,
      failedLines,
      handlerCount,
    });
    progress.push({ id, criterion, ...evaluated });
  }

  return progress;
}

/**
 * Evaluate a single success criterion against pipeline state.
 *
 * Criterion IDs (1-6) correspond to the standard mission.md format:
 *   1. Zero-to-autonomous setup
 *   2. Self-correction rate
 *   3. No zombies/deadlocks
 *   4. Dashboard visibility
 *   5. Measurable progress
 *   6. Multi-agent support
 * The default case handles unknown criteria safely (returns "not-met").
 */
function evaluateCriterion(
  id: number,
  _criterion: string,
  ctx: {
    devDir: string;
    completedCount: number;
    failedLines: { status: string }[];
    handlerCount: number;
  }
): { status: MissionProgress["status"]; evidence: string } {
  switch (id) {
    case 1: {
      // "Any project can go from zero to autonomous AI development in under 5 minutes"
      // Check: CLI init command exists + handlers are available (functional pipeline)
      const hasInit = handlerCountCheck(ctx.handlerCount, 5);
      if (hasInit) return { status: "met", evidence: `${ctx.handlerCount} dashboard handlers available, CLI init functional` };
      return { status: "partial", evidence: `${ctx.handlerCount} handlers — more needed for full coverage` };
    }
    case 2: {
      // "The pipeline self-corrects 95%+ of failures without human intervention"
      const fixedCount = ctx.failedLines.filter((f) => f.status.includes("fixed")).length;
      const supersededCount = ctx.failedLines.filter((f) => f.status.includes("superseded")).length;
      const blockedCount = ctx.failedLines.filter((f) => f.status.includes("blocked")).length;
      const selfCorrected = fixedCount + supersededCount;
      const totalResolved = selfCorrected + blockedCount;
      if (totalResolved === 0) return { status: "partial", evidence: "No failed tasks resolved yet" };
      const fixRate = selfCorrected / totalResolved;
      const pct = Math.round(fixRate * 100);
      if (fixRate >= 0.95) return { status: "met", evidence: `${pct}% self-correction rate (${selfCorrected}/${totalResolved} resolved autonomously)` };
      if (fixRate >= 0.5) return { status: "partial", evidence: `${pct}% self-correction rate (${selfCorrected}/${totalResolved}) — target 95%` };
      return { status: "not-met", evidence: `${pct}% self-correction rate (${selfCorrected}/${totalResolved}) — target 95%` };
    }
    case 3: {
      // "Workers never lose tasks, deadlock, or produce zombie processes"
      // Check watchdog logs for zombie/deadlock references
      const watchdogLog = readDevFile(`${ctx.devDir}/scripts`, "watchdog.log");
      const zombieRefs = (watchdogLog.match(/zombie/gi) || []).length;
      const deadlockRefs = (watchdogLog.match(/deadlock/gi) || []).length;
      const totalIssues = zombieRefs + deadlockRefs;
      if (totalIssues === 0) return { status: "met", evidence: "No zombie/deadlock references in watchdog logs" };
      if (totalIssues <= 3) return { status: "partial", evidence: `${totalIssues} zombie/deadlock reference(s) in watchdog logs` };
      return { status: "not-met", evidence: `${totalIssues} zombie/deadlock references in watchdog logs` };
    }
    case 4: {
      // "The dashboard provides full real-time visibility into pipeline health"
      // Check number of dashboard handlers
      if (ctx.handlerCount >= 8) return { status: "met", evidence: `${ctx.handlerCount} dashboard handlers providing full visibility` };
      if (ctx.handlerCount >= 5) return { status: "partial", evidence: `${ctx.handlerCount} dashboard handlers — growing coverage` };
      return { status: "not-met", evidence: `Only ${ctx.handlerCount} dashboard handlers` };
    }
    case 5: {
      // "Mission progress is measurable — completed tasks map to mission objectives"
      if (ctx.completedCount >= 10) return { status: "met", evidence: `${ctx.completedCount} tasks completed and tracked` };
      if (ctx.completedCount >= 3) return { status: "partial", evidence: `${ctx.completedCount} tasks completed — building momentum` };
      return { status: "not-met", evidence: `Only ${ctx.completedCount} tasks completed` };
    }
    case 6: {
      // "The system works with any LLM agent (Claude, Codex, future models)"
      // Check if agent plugin scripts exist under scripts/agents/
      const projectRoot = ctx.devDir.replace(/\/?\.dev\/?$/, "");
      const agentsDir = `${projectRoot}/scripts/agents`;
      let agentPlugins: string[] = [];
      try {
        if (existsSync(agentsDir)) {
          agentPlugins = readdirSync(agentsDir).filter((f: string) => f.endsWith(".sh"));
        }
      } catch {
        /* ignore */
      }
      if (agentPlugins.length >= 2) return { status: "met", evidence: `${agentPlugins.length} agent plugins: ${agentPlugins.join(", ")}` };
      if (agentPlugins.length === 1) return { status: "partial", evidence: `1 agent plugin: ${agentPlugins[0]} — need more for multi-agent support` };
      return { status: "not-met", evidence: "No agent plugins found in scripts/agents/" };
    }
    default:
      return { status: "not-met", evidence: "Unknown criterion — no evaluation logic" };
  }
}

function handlerCountCheck(count: number, threshold: number): boolean {
  return count >= threshold;
}

/**
 * Create a GET handler for the pipeline/status endpoint.
 * Returns full monitoring status including workers, tasks, backlog, sync health, auth, and git.
 */
export function createPipelineStatusHandler(config: SkynetConfig) {
  const { devDir, lockPrefix, workers: workerDefs } = config;

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

      // --- Try SQLite as primary data source ---
      let usingSqlite = false;
      let db: ReturnType<typeof getSkynetDB> | null = null;
      try {
        db = getSkynetDB(devDir);
        // Verify the DB is initialized (tables exist) with a cheap query
        db.countPending();
        usingSqlite = true;
      } catch (sqliteErr) {
        db = null;
        console.warn(`[pipeline-status] SQLite init failed, using files: ${sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr)}`);
      }

      const maxW = config.maxWorkers ?? 4;

      // Current tasks
      let currentTasks: Record<string, ReturnType<typeof parseCurrentTask>> = {};
      if (usingSqlite && db) {
        currentTasks = db.getAllCurrentTasks(maxW);
      }
      // Fill in missing workers from files (per-worker fallback)
      for (let wid = 1; wid <= maxW; wid++) {
        const key = `worker-${wid}`;
        if (!currentTasks[key]) {
          const raw = readDevFile(devDir, `current-task-${wid}.md`);
          if (raw) currentTasks[key] = parseCurrentTask(raw);
        }
      }
      // Legacy single file fallback
      const currentTaskRaw = readDevFile(devDir, "current-task.md");
      const currentTask = parseCurrentTask(currentTaskRaw);
      if (Object.keys(currentTasks).length === 0 && currentTaskRaw) {
        currentTasks["worker-1"] = currentTask;
      }

      // Worker heartbeats
      let heartbeats: Record<string, { lastEpoch: number | null; ageMs: number | null; isStale: boolean }> = {};
      if (usingSqlite && db) {
        heartbeats = db.getHeartbeats(maxW);
      } else {
        const staleThresholdMs = STALE_THRESHOLD_SECONDS * 1000;
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
      }

      // Backlog
      let backlog: ReturnType<typeof parseBacklogWithBlocked>;
      if (usingSqlite && db) {
        backlog = db.getBacklogItems();
      } else {
        const backlogRaw = readDevFile(devDir, "backlog.md");
        backlog = parseBacklogWithBlocked(backlogRaw);
      }

      // Completed
      let completed: { date: string; task: string; branch: string; duration: string; notes: string }[];
      let averageTaskDuration: string | null;
      if (usingSqlite && db) {
        completed = db.getCompletedTasks(50);
        averageTaskDuration = db.getAverageTaskDuration();
      } else {
        const completedRaw = readDevFile(devDir, "completed.md");
        const completedLines = completedRaw
          .split("\n")
          .filter(
            (l) =>
              l.startsWith("|") &&
              !l.includes("Date") &&
              !l.includes("---")
          );
        completed = completedLines.map((l) => {
          const parts = l.split("|").map((p) => p.trim());
          const hasDuration = parts.length >= 7;
          return {
            date: parts[1] ?? "",
            task: parts[2] ?? "",
            branch: parts[3] ?? "",
            duration: hasDuration ? (parts[4] ?? "") : "",
            notes: hasDuration ? (parts[5] ?? "") : (parts[4] ?? ""),
          };
        });
        const durationMinutes = completed
          .map((c) => parseDurationMinutes(c.duration))
          .filter((d): d is number => d !== null);
        averageTaskDuration =
          durationMinutes.length > 0
            ? formatDuration(
                durationMinutes.reduce((a, b) => a + b, 0) / durationMinutes.length
              )
            : null;
      }

      // Failed tasks
      let failed: { date: string; task: string; branch: string; error: string; attempts: string; status: string }[];
      if (usingSqlite && db) {
        failed = db.getFailedTasks();
      } else {
        const failedRaw = readDevFile(devDir, "failed-tasks.md");
        const failedLines = failedRaw
          .split("\n")
          .filter(
            (l) =>
              l.startsWith("|") &&
              !l.includes("Date") &&
              !l.includes("---")
          );
        failed = failedLines.map((l) => {
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
      }

      // Blockers
      let hasBlockers: boolean;
      let blockerLines: string[];
      if (usingSqlite && db) {
        blockerLines = db.getActiveBlockerLines();
        hasBlockers = blockerLines.length > 0;
      } else {
        const blockersRaw = readDevFile(devDir, "blockers.md");
        const activeMatch = blockersRaw.match(/## Active\s*\n([\s\S]*?)(?:\n## |\n*$)/i);
        const activeSection = activeMatch?.[1]?.trim() ?? "";
        hasBlockers =
          activeSection.length > 0 &&
          activeSection.toLowerCase() !== "none" &&
          !activeSection.includes("No active blockers");
        blockerLines = hasBlockers
          ? activeSection.split("\n").filter((l) => l.startsWith("- "))
          : [];
      }

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
      const tokenCachePath = config.authTokenCache ?? `${lockPrefix}-claude-token`;
      const authFailPath = config.authFailFlag ?? `${lockPrefix}-auth-failed`;

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

      const codexAuthFile =
        config.codexAuthFile ??
        process.env.SKYNET_CODEX_AUTH_FILE ??
        (process.env.HOME ? `${process.env.HOME}/.codex/auth.json` : "");
      let codexAuth: CodexAuthStatus = {
        status: "missing",
        expiresInMs: null,
        hasRefreshToken: false,
        source: "missing",
      };
      if (process.env.OPENAI_API_KEY) {
        codexAuth = {
          status: "api_key",
          expiresInMs: null,
          hasRefreshToken: false,
          source: "api_key",
        };
      } else if (codexAuthFile && existsSync(codexAuthFile)) {
        codexAuth = readCodexAuthStatus((p, enc) => readFileSync(p, enc), codexAuthFile);
      }

      // Backlog mutex
      const backlogLockPath = `${lockPrefix}-backlog.lock`;
      const backlogLocked = existsSync(backlogLockPath);

      // Git status — run in project root (parent of devDir)
      const projectRoot = devDir.replace(/\/?\.dev\/?$/, "");
      let gitBranch = "unknown";
      let commitsAhead = 0;
      let dirtyFiles = 0;
      let lastGitCommit: string | null = null;
      try {
        const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: projectRoot, encoding: "utf-8", timeout: 5000,
        });
        if (branchResult.status === 0) gitBranch = (branchResult.stdout?.trim()) || "unknown";

        const aheadResult = spawnSync("git", ["rev-list", "--count", "origin/main..HEAD"], {
          cwd: projectRoot, encoding: "utf-8", timeout: 5000,
        });
        commitsAhead = aheadResult.status === 0 ? (Number(aheadResult.stdout?.trim()) || 0) : 0;

        const dirtyResult = spawnSync("git", ["status", "--porcelain"], {
          cwd: projectRoot, encoding: "utf-8", timeout: 5000,
        });
        if (dirtyResult.status === 0) {
          const dirtyOutput = dirtyResult.stdout?.trim() || "";
          dirtyFiles = dirtyOutput ? dirtyOutput.split("\n").length : 0;
        }

        const logResult = spawnSync("git", ["log", "-1", "--format=%H %s"], {
          cwd: projectRoot, encoding: "utf-8", timeout: 5000,
        });
        lastGitCommit = logResult.status === 0 ? (logResult.stdout?.trim() || null) : null;
      } catch (err) {
        if (process.env.NODE_ENV === "development") console.warn("[pipeline-status] git error:", err);
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

      // Health score and self-correction stats
      let healthScore: number;
      let failedPendingCount: number;
      let selfCorrectionStats: { fixed: number; blocked: number; superseded: number; pending: number; selfCorrected: number };
      let selfCorrectionRate: number;

      if (usingSqlite && db) {
        healthScore = db.calculateHealthScore(maxW);
        const stats = db.getSelfCorrectionStats();
        selfCorrectionStats = stats;
        failedPendingCount = stats.pending;
        const totalResolved = stats.selfCorrected + stats.blocked;
        selfCorrectionRate = totalResolved > 0
          ? Math.round((stats.selfCorrected / totalResolved) * 100)
          : 0;
      } else {
        failedPendingCount = failed.filter((f) =>
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

        healthScore = calculateHealthScore({
          failedPendingCount,
          blockerCount: blockerLines.length,
          staleHeartbeatCount,
          staleTasks24hCount,
        });

        const fixedCount = failed.filter((f) => f.status.includes("fixed")).length;
        const supersededCount = failed.filter((f) => f.status.includes("superseded")).length;
        const blockedCount = failed.filter((f) => f.status.includes("blocked")).length;
        const selfCorrectedCount = fixedCount + supersededCount;
        selfCorrectionStats = {
          fixed: fixedCount,
          blocked: blockedCount,
          superseded: supersededCount,
          pending: failedPendingCount,
          selfCorrected: selfCorrectedCount,
        };
        const totalResolved = selfCorrectedCount + blockedCount;
        selfCorrectionRate = totalResolved > 0
          ? Math.round((selfCorrectedCount / totalResolved) * 100)
          : 0;
      }

      // Mission progress — count handlers from this package
      let handlerCount = 0;
      try {
        const handlersDir = dirname(fileURLToPath(import.meta.url));
        handlerCount = readdirSync(handlersDir).filter(
          (f: string) =>
            (f.endsWith(".ts") || f.endsWith(".js")) &&
            !f.includes(".test.") &&
            f !== "index.ts" &&
            f !== "index.js"
        ).length;
      } catch {
        /* ignore */
      }

      // NOTE: getCompletedCount() queries all terminal success states: completed, fixed, done.
      // Keep in sync with CLI status.ts and db.ts.
      const completedTotal = (usingSqlite && db) ? db.getCompletedCount() : completed.length;

      const missionProgress = parseMissionProgress({
        devDir,
        completedCount: completedTotal,
        failedLines: failed,
        handlerCount,
      });

      return Response.json({
        data: {
          workers,
          currentTask,
          currentTasks,
          heartbeats,
          backlog,
          completed: completed.slice(-50),
          completedCount: completedTotal,
          averageTaskDuration,
          failed,
          failedPendingCount,
          hasBlockers,
          blockerLines,
          healthScore,
          selfCorrectionRate,
          selfCorrectionStats,
          syncHealth: {
            lastRun: lastSyncMatch?.[1] ?? null,
            endpoints: syncEndpoints,
          },
          auth: {
            tokenCached,
            tokenCacheAgeMs,
            authFailFlag,
            lastFailEpoch,
            codex: codexAuth,
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
          missionProgress,
          timestamp: new Date().toISOString(),
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
  };
}
