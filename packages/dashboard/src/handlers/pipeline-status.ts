import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import type { SkynetConfig, CodexAuthStatus, MissionState } from "../types";
import { readDevFile, getLastLogLine, extractTimestamp } from "../lib/file-reader";
import { STALE_THRESHOLD_SECONDS } from "../lib/constants";
import { getWorkerStatus } from "../lib/worker-status";
import { getSkynetDB } from "../lib/db";
import { parseBacklogWithBlocked } from "../lib/backlog-parser";
import { decodeJwtExp } from "../lib/jwt";
import { calculateHealthScore } from "../lib/health";
import { parseMissionProgress } from "../lib/mission";

/**
 * Extract significant keywords from the mission Goals section.
 * Used for mission-alignment scoring — a completed task is "aligned" if
 * its tag or title shares significant keywords with mission goals.
 */
function extractMissionGoalKeywords(devDir: string, slug: string | null): Set<string> {
  let raw = "";
  if (slug) raw = readDevFile(devDir, `missions/${slug}.md`);
  if (!raw) raw = readDevFile(devDir, "mission.md");
  if (!raw) return new Set();

  // Extract ## Goals section
  const goalsMatch = raw.match(/## Goals\s*\n([\s\S]*?)(?:\n## |\n*$)/i);
  if (!goalsMatch) return new Set();

  const words = goalsMatch[1]
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  return new Set(words);
}

/**
 * Compute mission-alignment score (0-100) for the pipeline.
 *
 * Formula:
 *   - Alignment ratio (60 pts): (aligned / total completed last 24h) * 60
 *   - Velocity positive (20 pts): any completions in last 24h
 *   - Fix rate healthy (20 pts): self-correction rate > 50%
 *
 * A task is "aligned" if its tag or title shares keywords with mission Goals.
 * Returns { score, nonAlignedCount }.
 */
function computeMissionAlignment(
  completed: { date: string; task: string }[],
  goalKeywords: Set<string>,
  selfCorrectionRate: number,
): { score: number; nonAlignedCount: number } {
  if (goalKeywords.size === 0) {
    return { score: 100, nonAlignedCount: 0 };
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = completed.filter((t) => {
    if (!t.date) return false;
    try { return new Date(t.date) >= dayAgo; } catch { return false; }
  });

  let alignedCount = 0;
  for (const task of recent) {
    const taskWords = new Set(
      task.task.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
    );
    // A task is aligned if any significant word matches a goal keyword
    let aligned = false;
    for (const word of taskWords) {
      if (goalKeywords.has(word)) { aligned = true; break; }
    }
    if (aligned) alignedCount++;
  }

  const totalRecent = recent.length;
  const nonAlignedCount = totalRecent - alignedCount;

  // Alignment ratio: 60 points
  const alignmentPts = totalRecent > 0
    ? Math.round((alignedCount / totalRecent) * 60)
    : 60; // No recent tasks = no penalty

  // Velocity positive: 20 points if any completions in last 24h
  const velocityPts = totalRecent > 0 ? 20 : 0;

  // Fix rate healthy: 20 points if self-correction rate > 50%
  const fixRatePts = selfCorrectionRate > 50 ? 20 : 0;

  const score = Math.max(0, Math.min(100, alignmentPts + velocityPts + fixRatePts));
  return { score, nonAlignedCount };
}

// Module-level ring buffer for health trend (persists across requests, resets on restart)
const HEALTH_TREND_MAX = 60;
export const healthTrendBuffer: { ts: number; score: number }[] = [];

function pushHealthTrend(score: number) {
  healthTrendBuffer.push({ ts: Date.now(), score });
  if (healthTrendBuffer.length > HEALTH_TREND_MAX) {
    healthTrendBuffer.shift();
  }
}

function getActiveMissionSlug(devDir: string | undefined): string | null {
  if (!devDir) return null;
  try {
    const configPath = resolve(devDir, "missions", "_config.json");
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as { activeMission?: string };
    const slug = config.activeMission;
    if (!slug) return null;
    const missionPath = resolve(devDir, "missions", `${slug}.md`);
    if (!existsSync(missionPath)) return null;
    return slug;
  } catch {
    return null;
  }
}

function getMissionState(devDir: string | undefined, slug: string | null): MissionState | null {
  if (!devDir) return null;
  let raw = "";
  if (slug) {
    raw = readDevFile(devDir, `missions/${slug}.md`);
  }
  if (!raw) {
    raw = readDevFile(devDir, "mission.md");
  }
  if (!raw) return null;
  const match = raw.match(/^## State:\s*(.+)/im);
  return match ? (match[1].trim().toUpperCase() as MissionState) : null;
}

import { logHandlerError } from "../lib/handler-error";

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
 *
 * NOTE: This only handles integer durations (e.g., "23m", "1h 12m") matching
 * the bash pipeline's format_duration() output in dev-worker.sh, which always
 * produces integer hours and minutes from whole-second epoch arithmetic.
 * Decimal inputs like "1.5h" will return null — this is intentional.
 */
// NOTE: duration parsing also exists in packages/cli/src/commands/metrics.ts
export function parseDurationMinutes(s: string): number | null {
  const hm = s.match(/^(\d+)h\s+(\d+)m$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const hOnly = s.match(/^(\d+)h$/);
  if (hOnly) return Number(hOnly[1]) * 60;
  const mOnly = s.match(/^(\d+)m$/);
  if (mOnly) return Number(mOnly[1]);
  return null;
}

// NOTE: This formatDuration takes minutes; the one in packages/cli/src/commands/status.ts takes milliseconds.
// Keep signature difference intentional — dashboard uses minutes from task duration fields.
/**
 * Format minutes as a human-readable duration string (e.g., "23m", "1h 12m").
 */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return "--";
  // TEST-P3-1: Clamp negative values to 0 — negative durations are not meaningful
  if (minutes < 0) {
    console.warn(`[formatDuration] Negative duration encountered: ${minutes}m — clamping to 0`);
    return "0m";
  }
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
    // Type assertion: codex auth.json is an external file with no schema guarantee
    const raw = JSON.parse(readFile(authFile, "utf-8")) as { tokens?: { id_token?: string; access_token?: string; refresh_token?: string } };
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
 * Create a GET handler for the pipeline/status endpoint.
 * Returns full monitoring status including workers, tasks, backlog, sync health, auth, and git.
 *
 * TS-P3-6: Any JSON.parse calls for external files (e.g., codex auth.json,
 * watchdog-telemetry.json) must be wrapped in try/catch to handle malformed
 * JSON gracefully. The codex auth read (readCodexAuthStatus) is already
 * protected. If watchdog-telemetry.json consumption is added in the future,
 * ensure it follows the same pattern.
 */
export function createPipelineStatusHandler(config: SkynetConfig) {
  const { devDir, lockPrefix, workers: workerDefs } = config;

  // Cache handler count — handlers don't change at runtime
  // OPS-P3-5: Add 1-hour TTL to cached handler count
  let _cachedHandlerCount: number | null = null;
  let _handlerCountCachedAt = 0;
  const HANDLER_COUNT_TTL_MS = 60 * 60 * 1000; // 1 hour
  function getHandlerCount(): number {
    // In development, handler files may change via HMR — skip cache
    const now = Date.now();
    if (_cachedHandlerCount !== null && process.env.NODE_ENV !== "development" && (now - _handlerCountCachedAt) < HANDLER_COUNT_TTL_MS) return _cachedHandlerCount;
    try {
      const handlersDir = dirname(fileURLToPath(import.meta.url));
      _cachedHandlerCount = readdirSync(handlersDir).filter(
        (f: string) =>
          (f.endsWith(".ts") || f.endsWith(".js")) &&
          !f.includes(".test.") &&
          f !== "index.ts" &&
          f !== "index.js"
      ).length;
      _handlerCountCachedAt = now;
    } catch {
      _cachedHandlerCount = 0;
      _handlerCountCachedAt = now;
    }
    return _cachedHandlerCount;
  }

  return async function GET(request?: Request): Promise<Response> {
    try {
      const warnings: string[] = [];

      // Extract optional mission slug from query params
      let requestedMission: string | null = null;
      if (request) {
        try {
          const url = new URL(request.url);
          requestedMission = url.searchParams.get("slug");
        } catch { /* ignore */ }
      }

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
        db = getSkynetDB(devDir, { readonly: true });
        // Verify the DB is initialized (tables exist) with a cheap query
        db.countPending();
        usingSqlite = true;
      } catch (sqliteErr) {
        db = null;
        console.warn(`[pipeline-status] SQLite init failed, using files: ${sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr)}`);
        warnings.push("SQLite unavailable, using file fallback");
      }

      const maxW = config.maxWorkers ?? 4;

      // Current tasks
      const activeMission = getActiveMissionSlug(devDir);

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
      // NOTE: SQLite (workers.heartbeat_epoch) is the authoritative source for
      // heartbeat data. The file-based heartbeat path below is a legacy fallback
      // for installations that predate the SQLite migration. File-based reads are
      // subject to TOCTOU races (file can change between existence check and read)
      // but this is acceptable for display-only status — no control flow depends
      // on the file-based values.
      let heartbeats: Record<string, { lastEpoch: number | null; ageMs: number | null; isStale: boolean }> = {};
      if (usingSqlite && db) {
        heartbeats = db.getHeartbeats(maxW, config.staleMinutes);
      } else {
        // Use config.staleMinutes if set, otherwise fall back to STALE_THRESHOLD_SECONDS default
        const staleThresholdSeconds = config.staleMinutes != null ? config.staleMinutes * 60 : STALE_THRESHOLD_SECONDS;
        const staleThresholdMs = staleThresholdSeconds * 1000;
        for (let wid = 1; wid <= maxW; wid++) {
          const hbRaw = readDevFile(devDir, `worker-${wid}.heartbeat`).trim();
          if (hbRaw) {
            const epoch = Number(hbRaw);
            if (Number.isFinite(epoch)) {
              const ageMs = Date.now() - epoch * 1000;
              heartbeats[`worker-${wid}`] = {
                lastEpoch: epoch,
                ageMs,
                isStale: ageMs > staleThresholdMs,
              };
            } else {
              heartbeats[`worker-${wid}`] = { lastEpoch: null, ageMs: null, isStale: false };
            }
          } else {
            heartbeats[`worker-${wid}`] = { lastEpoch: null, ageMs: null, isStale: false };
          }
        }
      }

      // Backlog
      let backlog: ReturnType<typeof parseBacklogWithBlocked>;
      if (usingSqlite && db) {
        backlog = db.getBacklogItems(activeMission ?? "");
      } else {
        const backlogRaw = readDevFile(devDir, "backlog.md");
        backlog = parseBacklogWithBlocked(backlogRaw);
      }

      // Completed
      let completed: { date: string; task: string; branch: string; duration: string; notes: string }[];
      let averageTaskDuration: string | null;
      if (usingSqlite && db) {
        completed = db.getCompletedTasks(50, activeMission ?? "");
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
        failed = db.getFailedTasks(activeMission ?? "");
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
          // TS-P2-2: Bounds check — default to empty string if insufficient parts
          const hasFullRow = parts.length >= 7;
          return {
            date: parts[1] ?? "",
            task: parts[2] ?? "",
            branch: parts[3] ?? "",
            error: hasFullRow ? (parts[4] ?? "") : "",
            attempts: hasFullRow ? (parts[5] ?? "") : "",
            status: hasFullRow ? (parts[6] ?? "") : "",
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
          const raw = Number(readFileSync(authFailPath, "utf-8").trim());
          lastFailEpoch = Number.isFinite(raw) ? raw : null;
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

      // Gemini auth status
      let geminiAuth: { status: "ok" | "missing"; source: "api_key" | "cli_oauth" | "adc" | "missing" } = {
        status: "missing",
        source: "missing",
      };
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
        geminiAuth = { status: "ok", source: "api_key" };
      } else {
        const home = process.env.HOME || "";
        const cliAuthPath = resolve(home, ".gemini/oauth_creds.json");
        const adcPath = resolve(home, ".config/gcloud/application_default_credentials.json");
        
        if (home && existsSync(cliAuthPath)) {
          geminiAuth = { status: "ok", source: "cli_oauth" };
        } else if (home && existsSync(adcPath)) {
          geminiAuth = { status: "ok", source: "adc" };
        }
      }

      // Backlog mutex
      const backlogLockPath = `${lockPrefix}-backlog.lock`;
      const backlogLocked = existsSync(backlogLockPath);

            // Watchdog status
            const watchdogLockDir = `${lockPrefix}-watchdog.lock`;
            const watchdogPidPath = resolve(watchdogLockDir, "pid");
            let watchdogRunning = false;
            if (existsSync(watchdogPidPath)) {
              try {
                const pid = readFileSync(watchdogPidPath, "utf-8").trim();
                if (pid) {
                  // Check if PID is alive (non-destructive signal 0)
                  const killResult = spawnSync("kill", ["-0", pid]);
                  watchdogRunning = killResult.status === 0;
                }
              } catch { /* ignore */ }
            }
      
            // Project-driver status
            let projectDriverRunning = false;
            try {
              const scriptsDir = resolve(devDir, "scripts");
              // We look for any project-driver lock file
              const pdLocks = readdirSync(devDir).filter(f => f.startsWith(`${lockPrefix}-project-driver-`) && f.endsWith(".lock"));
              for (const lockDir of pdLocks) {
                const pidPath = resolve(devDir, lockDir, "pid");
                if (existsSync(pidPath)) {
                  const pid = readFileSync(pidPath, "utf-8").trim();
                  if (pid) {
                    const killResult = spawnSync("kill", ["-0", pid]);
                    if (killResult.status === 0) {
                      projectDriverRunning = true;
                      break;
                    }
                  }
                }
              }
            } catch { /* ignore */ }
      
            // Git status — run in project root (parent of devDir)
      // NOTE: spawnSync calls are blocking but each completes in <10ms for git metadata queries.
      // The total cost (~40ms for 4 calls) is acceptable for the status endpoint's ~1s polling
      // interval. Combining them into fewer calls trades readability for ~15ms savings.
      // Use path.resolve for robustness with spaces and special characters
      const projectRoot = resolve(devDir, "..");
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
        if (aheadResult.status === 0) {
          const parsed = Number(aheadResult.stdout?.trim());
          commitsAhead = Number.isFinite(parsed) ? parsed : 0;
        }

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
        healthScore = db.calculateHealthScore(maxW, config.staleMinutes);
        const stats = db.getSelfCorrectionStats(activeMission ?? "");
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
      const handlerCount = getHandlerCount();

      // NOTE: getCompletedCount() queries all terminal success states: completed, fixed, done.
      // Keep in sync with CLI status.ts and db.ts.
      const completedTotal = (usingSqlite && db) ? db.getCompletedCount(activeMission ?? "") : completed.length;

      const missionProgress = parseMissionProgress({
        devDir,
        completedCount: completedTotal,
        failedLines: failed,
        handlerCount,
        missionSlug: requestedMission || activeMission,
      });

      // Per-worker performance stats
      let workerStats: Record<string, { completedCount: number; failedCount: number; avgDuration: string | null; successRate: number }> = {};
      if (usingSqlite && db) {
        workerStats = db.getWorkerPerformanceStats(maxW);
      } else {
        // File fallback: completed.md lacks worker_id — return empty stats
        for (let wid = 1; wid <= maxW; wid++) {
          workerStats[`worker-${wid}`] = { completedCount: 0, failedCount: 0, avgDuration: null, successRate: 0 };
        }
      }

      // Mission alignment score
      const goalKeywords = extractMissionGoalKeywords(devDir, requestedMission || activeMission);
      const { score: missionAlignmentScore, nonAlignedCount: nonAlignedTaskCount } =
        computeMissionAlignment(completed, goalKeywords, selfCorrectionRate);

      pushHealthTrend(healthScore);

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
            gemini: geminiAuth,
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
          missionState: getMissionState(devDir, requestedMission || activeMission),
          missionProgress,
          missionAlignmentScore,
          nonAlignedTaskCount,
          workerStats,
          pipelinePaused: existsSync(resolve(devDir, "pipeline-paused")),
          watchdogRunning,
          projectDriverRunning,
          warnings,
          timestamp: new Date().toISOString(),
        },
        error: null,
      });
    } catch (err) {
      logHandlerError(devDir, "pipeline-status", err);
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
