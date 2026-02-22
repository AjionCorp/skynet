import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";
import { loadConfig } from "../utils/loadConfig";
import { isProcessRunning } from "../utils/isProcessRunning";
import { readFile } from "../utils/readFile";
import { isSqliteReady, sqliteScalar, sqliteRows } from "../utils/sqliteQuery";

interface StatusOptions {
  dir?: string;
  json?: boolean;
  quiet?: boolean;
}


function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  return `${hours}h ${remainingMins}m`;
}

function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

function getCodexAuthStatus(vars: Record<string, string>): string {
  if (process.env.OPENAI_API_KEY) {
    return "Codex Auth: OK (API key env)";
  }

  const authFile = vars.SKYNET_CODEX_AUTH_FILE || `${process.env.HOME || ""}/.codex/auth.json`;
  if (!authFile || !existsSync(authFile)) {
    return "Codex Auth: Missing (no auth file)";
  }

  try {
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

function parseRecentCompletions(completedContent: string, count: number): string[] {
  const lines = completedContent.split("\n").filter(
    (l) => l.startsWith("|") && !l.includes("| Date |") && !l.includes("---")
  );

  return lines.slice(-count).reverse().map((line) => {
    const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
    // Format: Date | Task | Branch | Notes
    const date = cols[0] || "";
    const task = cols[1] || "";
    return `${date}  ${task}`;
  });
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

  // --- Task Counts ---
  const usingSqlite = isSqliteReady(devDir);
  let pending = 0;
  let claimed = 0;
  let completedCount = 0;
  let failedPending = 0;
  let failedFixed = 0;
  let completedContent = "";
  let failed = "";

  if (usingSqlite) {
    try {
      pending = Number(sqliteScalar(devDir, "SELECT COUNT(*) FROM tasks WHERE status='pending';")) || 0;
      claimed = Number(sqliteScalar(devDir, "SELECT COUNT(*) FROM tasks WHERE status='claimed';")) || 0;
      completedCount = Number(sqliteScalar(devDir, "SELECT COUNT(*) FROM tasks WHERE status IN ('completed','done');")) || 0;
      failedPending = Number(sqliteScalar(devDir, "SELECT COUNT(*) FROM tasks WHERE status='failed';")) || 0;
      failedFixed = Number(sqliteScalar(devDir, "SELECT COUNT(*) FROM tasks WHERE status='fixed';")) || 0;
    } catch (err) {
      if (process.env.SKYNET_DEBUG) console.error(`  [debug] SQLite task counts: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!usingSqlite || (pending === 0 && claimed === 0 && completedCount === 0)) {
    const backlog = readFile(join(devDir, "backlog.md"));
    pending = (backlog.match(/^- \[ \] /gm) || []).length;
    claimed = (backlog.match(/^- \[>\] /gm) || []).length;

    completedContent = readFile(join(devDir, "completed.md"));
    const completedLines = completedContent
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.includes("| Date |") && !l.includes("---"));
    completedCount = completedLines.length;

    failed = readFile(join(devDir, "failed-tasks.md"));
    failedPending = (failed.match(/\| pending \|/g) || []).length;
    failedFixed = (failed.match(/\| fixed \|/g) || []).length;
  }

  print("  Tasks:");
  print(`    Pending:    ${pending}`);
  print(`    Claimed:    ${claimed}`);
  print(`    Completed:  ${completedCount}`);
  print(`    Failed:     ${failedPending} pending, ${failedFixed} fixed`);

  // --- Current Tasks (per-worker) ---
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
      hasActiveTasks = false;
    }
  }

  if (!hasActiveTasks) {
    // File-based current tasks
    const taskFiles = ["current-task.md"];
    try {
      const entries = readdirSync(devDir);
      for (const entry of entries) {
        if (entry.match(/^current-task-\d+\.md$/)) {
          taskFiles.push(entry);
        }
      }
    } catch {
      // ignore
    }

    for (const file of taskFiles) {
      const content = readFile(join(devDir, file));
      if (!content) continue;

      const titleMatch = content.match(/^## (.+)/m);
      const statusMatch = content.match(/\*\*Status:\*\* (\w+)/);
      const startedMatch = content.match(/\*\*Started:\*\* (.+)/);
      const workerMatch = content.match(/\*\*Worker:\*\* (\w+)/);

      const taskStatus = statusMatch?.[1] || "unknown";
      const taskTitle = titleMatch?.[1] || "Unknown";
      const fileLabel = workerMatch?.[1] ? `Worker ${workerMatch[1]}` : file.replace(".md", "");

      if (taskStatus === "in_progress" || taskStatus === "completed") {
        hasActiveTasks = true;
        let duration = "";
        if (startedMatch?.[1]) {
          const started = new Date(startedMatch[1]);
          if (!isNaN(started.getTime())) {
            duration = ` (${formatDuration(Date.now() - started.getTime())})`;
          }
        }

        const maxLen = 60;
        const shortTitle = taskTitle.length > maxLen
          ? taskTitle.substring(0, maxLen) + "..."
          : taskTitle;

        print(`    ${fileLabel}: [${taskStatus}] ${shortTitle}${duration}`);
      }
    }

    if (!hasActiveTasks) {
      print("    Idle — no active tasks");
    }
  }

  // --- Heartbeat staleness + task age for health score ---
  const maxWorkers = Number(vars.SKYNET_MAX_WORKERS) || 2;
  const staleThresholdMs = 45 * 60 * 1000;
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;

  if (usingSqlite) {
    try {
      const staleSecs = Math.floor(staleThresholdMs / 1000);
      staleHeartbeatCount = Number(sqliteScalar(devDir,
        `SELECT COUNT(*) FROM workers WHERE heartbeat_epoch > 0 AND (strftime('%s','now') - heartbeat_epoch) > ${staleSecs};`
      )) || 0;
      staleTasks24hCount = Number(sqliteScalar(devDir,
        `SELECT COUNT(*) FROM workers WHERE status='in_progress' AND started_at IS NOT NULL AND (julianday('now') - julianday(started_at)) > 1;`
      )) || 0;
    } catch (err) {
      if (process.env.SKYNET_DEBUG) console.error(`  [debug] SQLite heartbeats: ${err instanceof Error ? err.message : String(err)}`);
      staleHeartbeatCount = 0;
      staleTasks24hCount = 0;
    }
  }

  if (!usingSqlite || (staleHeartbeatCount === 0 && staleTasks24hCount === 0)) {
    for (let wid = 1; wid <= maxWorkers; wid++) {
      const hbPath = join(devDir, `worker-${wid}.heartbeat`);
      if (existsSync(hbPath)) {
        const epoch = Number(readFile(hbPath).trim());
        if (epoch && Date.now() - epoch * 1000 > staleThresholdMs) {
          staleHeartbeatCount++;
        }
      }
      const taskPath = join(devDir, `current-task-${wid}.md`);
      const taskContent = readFile(taskPath);
      if (taskContent) {
        const startedMatch = taskContent.match(/\*\*Started:\*\* (.+)/);
        if (startedMatch?.[1]) {
          const started = new Date(startedMatch[1]);
          if (!isNaN(started.getTime()) && Date.now() - started.getTime() > twentyFourHoursMs) {
            staleTasks24hCount++;
          }
        }
      }
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

  // --- Recent Completions ---
  let recent: string[] = [];

  if (usingSqlite) {
    try {
      const rows = sqliteRows(devDir, "SELECT completed_at, title FROM tasks WHERE status IN ('completed','done') ORDER BY completed_at DESC LIMIT 3;");
      recent = rows.map((r) => {
        const date = (r[0] || "").slice(0, 10);
        const title = r[1] || "";
        return `${date}  ${title}`;
      });
    } catch (err) {
      if (process.env.SKYNET_DEBUG) console.error(`  [debug] SQLite completions: ${err instanceof Error ? err.message : String(err)}`);
      recent = [];
    }
  }

  if (recent.length === 0) {
    if (!completedContent) {
      completedContent = readFile(join(devDir, "completed.md"));
    }
    recent = parseRecentCompletions(completedContent, 3);
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
    print(`\n  Auth: OK (token cached ${mins}m ago)`);
  } else {
    print("\n  Auth: No token cached");
  }
  print(`  ${getCodexAuthStatus(vars)}`);

  // --- Blockers ---
  let blockerCount = 0;

  if (usingSqlite) {
    try {
      blockerCount = Number(sqliteScalar(devDir, "SELECT COUNT(*) FROM blockers WHERE status='active';")) || 0;
    } catch (err) {
      if (process.env.SKYNET_DEBUG) console.error(`  [debug] SQLite blockers: ${err instanceof Error ? err.message : String(err)}`);
      blockerCount = 0;
    }
  }

  if (!usingSqlite || blockerCount === 0) {
    const blockers = readFile(join(devDir, "blockers.md"));
    if (blockers.includes("No active blockers")) {
      // keep 0
    } else {
      blockerCount = (blockers.match(/^- /gm) || []).length;
    }
  }

  if (blockerCount > 0) {
    print(`  Blockers: ${blockerCount} active`);
  } else {
    print("  Blockers: None");
  }

  // --- Health Score ---
  let healthScore = 100;
  healthScore -= failedPending * 5;
  healthScore -= blockerCount * 10;
  healthScore -= staleHeartbeatCount * 2;
  healthScore -= staleTasks24hCount * 1;
  healthScore = Math.max(0, Math.min(100, healthScore));

  const healthLabel = healthScore > 80 ? "Good" : healthScore > 50 ? "Degraded" : "Critical";
  print(`\n  Health Score: ${healthScore}/100 (${healthLabel})`);

  // --- Self-Correction Rate ---
  let scrFixed = 0;
  let scrBlocked = 0;
  let scrSuperseded = 0;

  if (usingSqlite) {
    try {
      scrFixed = Number(sqliteScalar(devDir, "SELECT COUNT(*) FROM tasks WHERE status='fixed';")) || 0;
      scrBlocked = Number(sqliteScalar(devDir, "SELECT COUNT(*) FROM tasks WHERE status='blocked';")) || 0;
      scrSuperseded = Number(sqliteScalar(devDir, "SELECT COUNT(*) FROM tasks WHERE status='superseded';")) || 0;
    } catch (err) {
      if (process.env.SKYNET_DEBUG) console.error(`  [debug] SQLite self-correction: ${err instanceof Error ? err.message : String(err)}`);
      scrFixed = 0;
    }
  }

  if (!usingSqlite || (scrFixed === 0 && scrBlocked === 0 && scrSuperseded === 0)) {
    // Ensure we have failed content loaded
    if (!failed) {
      failed = readFile(join(devDir, "failed-tasks.md"));
    }
    const failedLines = failed
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.includes("Date") && !l.includes("---"));
    scrFixed = failedLines.filter((l) => l.includes("| fixed |")).length;
    scrBlocked = failedLines.filter((l) => l.includes("| blocked |")).length;
    scrSuperseded = failedLines.filter((l) => l.includes("| superseded |")).length;
  }

  const scrSelfCorrected = scrFixed + scrSuperseded;
  const scrResolved = scrSelfCorrected + scrBlocked;
  const scrRate = scrResolved > 0 ? Math.round((scrSelfCorrected / scrResolved) * 100) : 0;
  print(`  Self-correction rate: ${scrRate}% (${scrFixed} fixed + ${scrSuperseded} routed around)`);

  // --- Mission Progress ---
  const missionRaw = readFile(join(devDir, "mission.md"));
  const missionProgress: { id: number; criterion: string; status: string; evidence: string }[] = [];
  if (missionRaw) {
    const scMatch = missionRaw.match(/## Success Criteria\s*\n([\s\S]*?)(?:\n## |\n*$)/i);
    if (scMatch) {
      const criteriaLines = scMatch[1]
        .split("\n")
        .filter((l) => /^\d+\.\s/.test(l.trim()));

      if (criteriaLines.length > 0) {
        // Gather evaluation inputs
        const watchdogLog = readFile(join(devDir, "scripts/watchdog.log"));
        const zombieRefs = (watchdogLog.match(/zombie/gi) || []).length;
        const deadlockRefs = (watchdogLog.match(/deadlock/gi) || []).length;

        const handlersDir = join(projectDir, "packages/dashboard/src/handlers");
        let handlerCount = 0;
        try {
          if (existsSync(handlersDir)) {
            handlerCount = readdirSync(handlersDir).filter(
              (f) => f.endsWith(".ts") && !f.includes(".test.") && f !== "index.ts"
            ).length;
          }
        } catch {
          /* ignore */
        }

        const agentsDir = join(projectDir, "scripts/agents");
        let agentPlugins: string[] = [];
        try {
          if (existsSync(agentsDir)) {
            agentPlugins = readdirSync(agentsDir).filter((f) => f.endsWith(".sh"));
          }
        } catch {
          /* ignore */
        }

        let metCount = 0;
        let partialCount = 0;
        const summaryLines: string[] = [];

        for (const line of criteriaLines) {
          const numMatch = line.trim().match(/^(\d+)\.\s+(.+)/);
          if (!numMatch) continue;
          const id = Number(numMatch[1]);
          const criterion = numMatch[2];

          let status: "met" | "partial" | "not-met" = "not-met";
          let evidence = "";

          switch (id) {
            case 1:
              if (handlerCount >= 5) { status = "met"; evidence = `${handlerCount} handlers`; }
              else { status = "partial"; evidence = `${handlerCount} handlers`; }
              break;
            case 2:
              if (scrResolved === 0) { status = "partial"; evidence = "No failures resolved yet"; }
              else {
                const pct = Math.round((scrSelfCorrected / scrResolved) * 100);
                if (pct >= 95) { status = "met"; evidence = `${pct}% self-correction (${scrSelfCorrected}/${scrResolved})`; }
                else if (pct >= 50) { status = "partial"; evidence = `${pct}% self-correction`; }
                else { status = "not-met"; evidence = `${pct}% self-correction`; }
              }
              break;
            case 3: {
              const issues = zombieRefs + deadlockRefs;
              if (issues === 0) { status = "met"; evidence = "No issues in watchdog"; }
              else if (issues <= 3) { status = "partial"; evidence = `${issues} issue(s)`; }
              else { status = "not-met"; evidence = `${issues} issues`; }
              break;
            }
            case 4:
              if (handlerCount >= 8) { status = "met"; evidence = `${handlerCount} handlers`; }
              else if (handlerCount >= 5) { status = "partial"; evidence = `${handlerCount} handlers`; }
              else { status = "not-met"; evidence = `${handlerCount} handlers`; }
              break;
            case 5:
              if (completedCount >= 10) { status = "met"; evidence = `${completedCount} tasks`; }
              else if (completedCount >= 3) { status = "partial"; evidence = `${completedCount} tasks`; }
              else { status = "not-met"; evidence = `${completedCount} tasks`; }
              break;
            case 6:
              if (agentPlugins.length >= 2) { status = "met"; evidence = `${agentPlugins.length} agents`; }
              else if (agentPlugins.length === 1) { status = "partial"; evidence = `1 agent`; }
              else { status = "not-met"; evidence = "No agents"; }
              break;
          }

          missionProgress.push({ id, criterion, status, evidence });

          if (status === "met") metCount++;
          else if (status === "partial") partialCount++;

          const icon = status === "met" ? "[MET]" : status === "partial" ? "[PARTIAL]" : "[NOT MET]";
          // Truncate criterion for display
          const maxLen = 50;
          const shortCriterion = criterion.length > maxLen
            ? criterion.substring(0, maxLen) + "..."
            : criterion;
          summaryLines.push(`    ${id}. ${icon} ${shortCriterion} (${evidence})`);
        }

        print(`\n  Mission Progress: ${metCount}/${criteriaLines.length} met, ${partialCount} partial`);
        for (const sl of summaryLines) {
          print(sl);
        }
      }
    }
  }

  // --- JSON output mode ---
  if (options.json) {
    const data = {
      project: projectName,
      paused: isPaused,
      tasks: { pending, claimed, completed: completedCount, failed: failedPending },
      workers: workerStatuses,
      healthScore,
      selfCorrectionRate: scrRate,
      missionProgress,
      lastActivity: lastActivity ? lastActivity.toISOString() : null,
    };
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
  }

  // --- Quiet output mode ---
  if (options.quiet) {
    console.log(healthScore);
    process.exit(0);
  }

  print("");
}
