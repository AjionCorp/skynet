import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../utils/loadConfig.js";
import { isProcessRunning } from "../utils/isProcessRunning.js";
import { isSqliteReady, sqliteRows, sqlInt } from "../utils/sqliteQuery.js";
import { decodeJwtExp, calculateHealthScore, parseMissionProgress } from "@ajioncorp/skynet";

interface StatusOptions {
  dir?: string;
  json?: boolean;
  quiet?: boolean;
}

// Stale threshold is computed inside statusCommand() from SKYNET_STALE_MINUTES config value.

// decodeJwtExp imported from @ajioncorp/skynet (see packages/dashboard/src/lib/jwt.ts)

// NOTE: This formatDuration takes milliseconds; the one in pipeline-status.ts takes minutes.
// Keep signature difference intentional — CLI displays durations from ms timestamps.
// Cross-ref: packages/dashboard/src/handlers/pipeline-status.ts (formatDuration, minutes)
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  return `${hours}h ${remainingMins}m`;
}

// NOTE: JWT exp is read for display purposes only (expiry estimation).
// The actual token validation happens server-side when the token is used.
// We do not verify the JWT signature here — that would require the issuer's
// public key, which is not available to the CLI.
function getCodexAuthStatus(vars: Record<string, string>): string {
  if (process.env.OPENAI_API_KEY) {
    return "Codex Auth: OK (API key env)";
  }

  const authFile = vars.SKYNET_CODEX_AUTH_FILE || `${process.env.HOME || ""}/.codex/auth.json`;
  if (!authFile || !existsSync(authFile)) {
    return "Codex Auth: Missing (no auth file)";
  }

  try {
    const fileSize = statSync(authFile).size;
    if (fileSize > 1_048_576) {
      return "Codex Auth: Invalid (auth file too large)";
    }
    const raw = readFileSync(authFile, "utf-8");
    const data = JSON.parse(raw);
    const tokens = data?.tokens || {};
    const token = tokens.id_token || tokens.access_token || "";
    const refresh = tokens.refresh_token || "";
    if (!token) {
      return "Codex Auth: Invalid (missing token)";
    }
    const exp = decodeJwtExp(token);
    if (!exp) {
      return refresh ? "Codex Auth: OK (no exp)" : "Codex Auth: OK (no exp, no refresh)";
    }
    const remaining = exp - Math.floor(Date.now() / 1000);
    const mins = Math.floor(Math.max(0, remaining) / 60);
    if (remaining <= 0) {
      return refresh ? "Codex Auth: Expired (refresh token present)" : "Codex Auth: Expired";
    }
    const refreshNote = refresh ? "" : " (no refresh token)";
    return `Codex Auth: OK (expires in ${mins}m)${refreshNote}`;
  } catch {
    return "Codex Auth: Invalid (unreadable auth file)";
  }
}

function getLastActivityTimestamp(devDir: string): Date | null {
  const files = ["backlog.md", "completed.md", "failed-tasks.md", "current-task.md"];
  let latest: Date | null = null;

  for (const file of files) {
    const filePath = join(devDir, file);
    if (existsSync(filePath)) {
      const mtime = statSync(filePath).mtime;
      if (!latest || mtime > latest) {
        latest = mtime;
      }
    }
  }

  // Also check per-worker current task files
  try {
    const entries = readdirSync(devDir);
    for (const entry of entries) {
      if (entry.match(/^current-task-\d+\.md$/)) {
        const mtime = statSync(join(devDir, entry)).mtime;
        if (!latest || mtime > latest) {
          latest = mtime;
        }
      }
    }
  } catch {
    // devDir may not be readable
  }

  return latest;
}

export async function statusCommand(options: StatusOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const projectName = vars.SKYNET_PROJECT_NAME;
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const lockPrefix = vars.SKYNET_LOCK_PREFIX || `/tmp/skynet-${projectName}`;

  // Use a conditional log so --json and --quiet suppress formatted output
  const print = (msg: string) => {
    if (!options.json && !options.quiet) console.log(msg);
  };

  const usingSqlite = isSqliteReady(devDir);
  if (!usingSqlite) {
    print("\n  WARNING: SQLite database not found. Run 'skynet init' to set up the pipeline.\n");
  }

  // --- Health Score Inputs ---
  let staleHeartbeatCount = 0;
  let staleTasks24hCount = 0;

  // --- Pause status ---
  const pauseFile = join(devDir, "pipeline-paused");
  let isPaused = false;
  if (existsSync(pauseFile)) {
    isPaused = true;
    let pauseInfo = "";
    try {
      const sentinel = JSON.parse(readFileSync(pauseFile, "utf-8"));
      pauseInfo = ` (since ${sentinel.pausedAt}, by ${sentinel.pausedBy})`;
    } catch {
      // sentinel exists but unreadable — still paused
    }
    print(`\n  Skynet Pipeline Status (${projectName}) — PAUSED${pauseInfo}\n`);
  } else {
    print(`\n  Skynet Pipeline Status (${projectName})\n`);
  }

  // --- Task Counts (SQLite only) ---
  // NOTE: completedCount queries all terminal success states: completed, fixed, done.
  // Keep in sync with dashboard (pipeline-status.ts) and db.ts (getCompletedCount).
  let pending = 0;
  let claimed = 0;
  let completedCount = 0;
  let failedPending = 0;
  let failedFixed = 0;

  if (usingSqlite) {
    try {
      const countsRow = sqliteRows(devDir,
        `SELECT
          (SELECT COUNT(*) FROM tasks WHERE status='pending') as c0,
          (SELECT COUNT(*) FROM tasks WHERE status='claimed') as c1,
          (SELECT COUNT(*) FROM tasks WHERE status IN ('completed','fixed','done')) as c2,
          (SELECT COUNT(*) FROM tasks WHERE status='failed') as c3,
          (SELECT COUNT(*) FROM tasks WHERE status='fixed') as c4;`
      );
      if (countsRow.length > 0) {
        const c = countsRow[0];
        pending = Number(c[0]) || 0;
        claimed = Number(c[1]) || 0;
        completedCount = Number(c[2]) || 0;
        failedPending = Number(c[3]) || 0;
        failedFixed = Number(c[4]) || 0;
      }
    } catch (err) {
      if (process.env.SKYNET_DEBUG) console.error(`  [debug] SQLite task counts: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  print("  Tasks:");
  print(`    Pending:    ${pending}`);
  print(`    Claimed:    ${claimed}`);
  print(`    Completed:  ${completedCount}`);
  print(`    Failed:     ${failedPending} pending, ${failedFixed} fixed`);

  // --- Current Tasks (SQLite only) ---
  print("\n  Current Tasks:");

  let hasActiveTasks = false;

  if (usingSqlite) {
    try {
      const rows = sqliteRows(devDir, "SELECT id, worker_type, status, task_title, started_at FROM workers WHERE status IN ('in_progress','completed') ORDER BY id;");
      for (const row of rows) {
        const wid = row[0] || "?";
        const wtype = row[1] || "dev";
        const wstatus = row[2] || "unknown";
        const wtitle = row[3] || "Unknown";
        const wstarted = row[4] || "";

        hasActiveTasks = true;
        let duration = "";
        if (wstarted) {
          const started = new Date(wstarted);
          if (!isNaN(started.getTime())) {
            duration = ` (${formatDuration(Date.now() - started.getTime())})`;
          }
        }

        const maxLen = 60;
        const shortTitle = wtitle.length > maxLen ? wtitle.substring(0, maxLen) + "..." : wtitle;
        const label = wtype === "fixer" ? `Fixer ${wid}` : `Worker ${wid}`;
        print(`    ${label}: [${wstatus}] ${shortTitle}${duration}`);
      }
    } catch (err) {
      if (process.env.SKYNET_DEBUG) console.error(`  [debug] SQLite current tasks: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!hasActiveTasks) {
    print("    Idle — no active tasks");
  }

  // --- Heartbeat staleness (SQLite only) ---
  const maxWorkers = Number(vars.SKYNET_MAX_WORKERS) || 2;
  // Use SKYNET_STALE_MINUTES from config if available, fallback to 30 minutes
  const staleMinutesFromConfig = vars ? Number(vars.SKYNET_STALE_MINUTES) : 0;
  const staleThresholdMs = ((staleMinutesFromConfig > 0 ? staleMinutesFromConfig : 30) * 60) * 1000;

  if (usingSqlite) {
    try {
      // staleSecs is computed from STALE_THRESHOLD_SECONDS — safe to interpolate
      const staleSecs = sqlInt(Math.floor(staleThresholdMs / 1000));
      const hbRow = sqliteRows(devDir,
        `SELECT
          (SELECT COUNT(*) FROM workers WHERE heartbeat_epoch > 0 AND (strftime('%s','now') - heartbeat_epoch) > ${staleSecs}) as c0,
          (SELECT COUNT(*) FROM workers WHERE status='in_progress' AND started_at IS NOT NULL AND (julianday('now') - julianday(started_at)) > 1) as c1;`
      );
      if (hbRow.length > 0) {
        staleHeartbeatCount = Number(hbRow[0][0]) || 0;
        staleTasks24hCount = Number(hbRow[0][1]) || 0;
      }
    } catch (err) {
      if (process.env.SKYNET_DEBUG) console.error(`  [debug] SQLite heartbeats: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Workers ---
  const workerNames = Array.from({ length: maxWorkers }, (_, i) => `dev-worker-${i + 1}`);
  const workers = [
    ...workerNames, "task-fixer", "project-driver",
    "sync-runner", "ui-tester", "feature-validator", "health-check",
    "auth-refresh", "codex-auth-refresh", "watchdog",
  ];

  let runningCount = 0;
  const workerStatuses: { name: string; pid: string; running: boolean }[] = [];

  for (const w of workers) {
    const lockFile = `${lockPrefix}-${w}.lock`;
    if (existsSync(lockFile)) {
      const { running, pid } = isProcessRunning(lockFile);
      workerStatuses.push({ name: w, pid, running });
      if (running) runningCount++;
    }
  }

  print(`\n  Workers: ${runningCount}/${workers.length}`);
  if (workerStatuses.length > 0) {
    for (const ws of workerStatuses) {
      const icon = ws.running ? "running" : "stale";
      const pidLabel = ws.pid ? ` (PID ${ws.pid})` : "";
      print(`    ${ws.name}: ${icon}${pidLabel}`);
    }
  } else {
    print("    No lock files found");
  }

  // --- Last Activity ---
  const lastActivity = getLastActivityTimestamp(devDir);
  if (lastActivity) {
    const ago = formatDuration(Date.now() - lastActivity.getTime());
    print(`\n  Last Activity: ${ago} ago`);
  }

  // --- Recent Completions (SQLite only) ---
  let recent: string[] = [];

  if (usingSqlite) {
    try {
      const rows = sqliteRows(devDir, "SELECT completed_at, title FROM tasks WHERE status IN ('completed','fixed','done') ORDER BY completed_at DESC LIMIT 3;");
      recent = rows.map((r) => {
        const date = (r[0] || "").slice(0, 10);
        const title = r[1] || "";
        return `${date}  ${title}`;
      });
    } catch (err) {
      if (process.env.SKYNET_DEBUG) console.error(`  [debug] SQLite completions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (recent.length > 0) {
    print("\n  Recent Completions:");
    for (const entry of recent) {
      print(`    ${entry}`);
    }
  }

  // --- Auth ---
  const tokenCache = vars.SKYNET_AUTH_TOKEN_CACHE || `${lockPrefix}-claude-token`;
  if (existsSync(tokenCache)) {
    const age = Date.now() - statSync(tokenCache).mtimeMs;
    const mins = Math.floor(age / 60000);
    // Check Claude token JWT expiry
    try {
      const tokenContent = readFileSync(tokenCache, "utf-8").trim();
      const claudeExp = decodeJwtExp(tokenContent);
      if (claudeExp) {
        const remainingSecs = claudeExp - Math.floor(Date.now() / 1000);
        const remainingHrs = Math.floor(Math.max(0, remainingSecs) / 3600);
        if (remainingSecs <= 0) {
          print(`\n  Claude Auth: EXPIRED (token cached ${mins}m ago)`);
        } else if (remainingSecs <= 86400) {
          print(`\n  Claude Auth: WARNING (expires in ${remainingHrs}h, cached ${mins}m ago)`);
        } else {
          print(`\n  Claude Auth: OK (expires in ${remainingHrs}h)`);
        }
      } else {
        print(`\n  Claude Auth: OK (token cached ${mins}m ago)`);
      }
    } catch {
      print(`\n  Claude Auth: OK (token cached ${mins}m ago)`);
    }
  } else {
    print("\n  Claude Auth: No token cached");
  }
  print(`  ${getCodexAuthStatus(vars)}`);

  // --- Blockers + Self-Correction (SQLite only) ---
  let blockerCount = 0;
  let scrFixed = 0;
  let scrBlocked = 0;
  let scrSuperseded = 0;

  if (usingSqlite) {
    try {
      const bRow = sqliteRows(devDir,
        `SELECT
          (SELECT COUNT(*) FROM blockers WHERE status='active') as c0,
          (SELECT COUNT(*) FROM tasks WHERE status='fixed') as c1,
          (SELECT COUNT(*) FROM tasks WHERE status='blocked') as c2,
          (SELECT COUNT(*) FROM tasks WHERE status='superseded') as c3;`
      );
      if (bRow.length > 0) {
        blockerCount = Number(bRow[0][0]) || 0;
        scrFixed = Number(bRow[0][1]) || 0;
        scrBlocked = Number(bRow[0][2]) || 0;
        scrSuperseded = Number(bRow[0][3]) || 0;
      }
    } catch (err) {
      if (process.env.SKYNET_DEBUG) console.error(`  [debug] SQLite blockers/scr: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (blockerCount > 0) {
    print(`  Blockers: ${blockerCount} active`);
  } else {
    print("  Blockers: None");
  }

  // --- Health Score ---
  // Uses canonical formula from @ajioncorp/skynet (packages/dashboard/src/lib/health.ts)
  const healthScore = calculateHealthScore({
    failedPendingCount: failedPending,
    blockerCount,
    staleHeartbeatCount,
    staleTasks24hCount,
  });

  const healthLabel = healthScore > 80 ? "Good" : healthScore > 50 ? "Degraded" : "Critical";
  print(`\n  Health Score: ${healthScore}/100 (${healthLabel})`);

  // --- Self-Correction Rate ---
  const scrSelfCorrected = scrFixed + scrSuperseded;
  const scrResolved = scrSelfCorrected + scrBlocked;
  const scrRate = scrResolved > 0 ? Math.round((scrSelfCorrected / scrResolved) * 100) : 0;
  print(`  Self-correction rate: ${scrRate}% (${scrFixed} fixed + ${scrSuperseded} routed around)`);

  // --- Mission Progress ---
  // Uses shared parseMissionProgress from @ajioncorp/skynet to ensure
  // consistent evaluation across dashboard and CLI surfaces.

  // Resolve active mission slug from multi-mission config
  let activeMissionSlug: string | null = null;
  try {
    const missionConfigPath = join(devDir, "missions", "_config.json");
    if (existsSync(missionConfigPath)) {
      const mc = JSON.parse(readFileSync(missionConfigPath, "utf-8")) as { activeMission?: string };
      if (mc.activeMission) {
        const missionPath = join(devDir, "missions", `${mc.activeMission}.md`);
        if (existsSync(missionPath)) {
          activeMissionSlug = mc.activeMission;
        }
      }
    }
  } catch { /* ignore — fall through to legacy mission.md */ }

  // Count handler files for mission evaluation context
  const handlersDir = join(projectDir, "packages/dashboard/src/handlers");
  let handlerCount = 0;
  try {
    if (existsSync(handlersDir)) {
      handlerCount = readdirSync(handlersDir).filter(
        (f) => f.endsWith(".ts") && !f.includes(".test.") && f !== "index.ts"
      ).length;
    }
  } catch { /* ignore */ }

  // Build failed task lines for self-correction evaluation
  const failedLines: { status: string }[] = [];
  if (usingSqlite) {
    try {
      const failedRows = sqliteRows(devDir, "SELECT status FROM tasks WHERE status IN ('failed','fixed','blocked','superseded');");
      for (const row of failedRows) {
        failedLines.push({ status: String(row[0] || "") });
      }
    } catch { /* ignore */ }
  }

  const missionProgress = parseMissionProgress({
    devDir,
    completedCount,
    failedLines,
    handlerCount,
    missionSlug: activeMissionSlug,
  });

  if (missionProgress.length > 0) {
    const metCount = missionProgress.filter((mp) => mp.status === "met").length;
    const partialCount = missionProgress.filter((mp) => mp.status === "partial").length;
    print(`\n  Mission Progress: ${metCount}/${missionProgress.length} met, ${partialCount} partial`);

    for (const mp of missionProgress) {
      const icon = mp.status === "met" ? "[MET]" : mp.status === "partial" ? "[PARTIAL]" : "[NOT MET]";
      const maxLen = 50;
      const shortCriterion = mp.criterion.length > maxLen
        ? mp.criterion.substring(0, maxLen) + "..."
        : mp.criterion;
      print(`    ${mp.id}. ${icon} ${shortCriterion} (${mp.evidence})`);
    }
  }

  // --- JSON output mode ---
  if (options.json) {
    // Check merge lock state
    const mergeLockDir = `${lockPrefix}-merge.lock`;
    let mergeLock: { held: boolean; pid?: number; ageSeconds?: number } = { held: false };
    try {
      const pidFile = join(mergeLockDir, "pid");
      if (existsSync(mergeLockDir) && existsSync(pidFile)) {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        const age = Math.floor((Date.now() - statSync(mergeLockDir).mtimeMs) / 1000);
        mergeLock = { held: true, pid, ageSeconds: age };
      } else if (existsSync(mergeLockDir)) {
        const age = Math.floor((Date.now() - statSync(mergeLockDir).mtimeMs) / 1000);
        mergeLock = { held: true, ageSeconds: age };
      }
    } catch {
      // ignore — lock may have been released between checks
    }

    const data = {
      project: projectName,
      paused: isPaused,
      tasks: { pending, claimed, completed: completedCount, failed: failedPending },
      workers: workerStatuses,
      mergeLock,
      healthScore,
      selfCorrectionRate: scrRate,
      activeMission: activeMissionSlug,
      missionProgress,
      lastActivity: lastActivity ? lastActivity.toISOString() : null,
    };
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // --- Quiet output mode ---
  if (options.quiet) {
    console.log(healthScore);
    return;
  }

  print("");
}
