import { existsSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../utils/loadConfig.js";
import { isProcessRunning } from "../utils/isProcessRunning.js";
import { readFile } from "../utils/readFile.js";
import { isSqliteReady, sqliteRows } from "../utils/sqliteQuery.js";
import { STALE_THRESHOLD_SECONDS } from "@ajioncorp/skynet";

interface WatchOptions {
  dir?: string;
}

// ANSI color codes
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";


function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  return `${hours}h ${remainingMins}m`;
}

function colorHealth(score: number): string {
  if (score > 80) return `${GREEN}${score}/100${RESET}`;
  if (score > 50) return `${YELLOW}${score}/100${RESET}`;
  return `${RED}${score}/100${RESET}`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max) + "..." : str;
}

// ── SQLite-backed data fetcher ──────────────────────────────────────────────

interface DashboardData {
  pending: number;
  claimed: number;
  completedCount: number;
  failedPending: number;
  failedFixed: number;
  blockerCount: number;
  staleHeartbeatCount: number;
  staleTasks24hCount: number;
  healthScore: number;
  scrFixed: number;
  scrBlocked: number;
  scrSuperseded: number;
  workers: { id: number; status: string; taskTitle: string; heartbeatEpoch: number | null; startedAt: string | null }[];
  events: string[];
  source: "sqlite" | "files";
}

function fetchFromSqlite(devDir: string): DashboardData | null {
  if (!isSqliteReady(devDir)) return null;

  try {
    // Task counts
    const countsRow = sqliteRows(devDir,
      `SELECT
        (SELECT COUNT(*) FROM tasks WHERE status='pending') as c0,
        (SELECT COUNT(*) FROM tasks WHERE status='claimed') as c1,
        (SELECT COUNT(*) FROM tasks WHERE status IN ('completed','fixed','done')) as c2,
        (SELECT COUNT(*) FROM tasks WHERE status='failed') as c3,
        (SELECT COUNT(*) FROM tasks WHERE status='fixed') as c4;`
    );
    let pending = 0, claimed = 0, completedCount = 0, failedPending = 0, failedFixed = 0;
    if (countsRow.length > 0) {
      const c = countsRow[0];
      pending = Number(c[0]) || 0;
      claimed = Number(c[1]) || 0;
      completedCount = Number(c[2]) || 0;
      failedPending = Number(c[3]) || 0;
      failedFixed = Number(c[4]) || 0;
    }

    // Self-correction stats + blockers
    const bRow = sqliteRows(devDir,
      `SELECT
        (SELECT COUNT(*) FROM blockers WHERE status='active') as c0,
        (SELECT COUNT(*) FROM tasks WHERE status='fixed') as c1,
        (SELECT COUNT(*) FROM tasks WHERE status='blocked') as c2,
        (SELECT COUNT(*) FROM tasks WHERE status='superseded') as c3;`
    );
    let blockerCount = 0, scrFixed = 0, scrBlocked = 0, scrSuperseded = 0;
    if (bRow.length > 0) {
      blockerCount = Number(bRow[0][0]) || 0;
      scrFixed = Number(bRow[0][1]) || 0;
      scrBlocked = Number(bRow[0][2]) || 0;
      scrSuperseded = Number(bRow[0][3]) || 0;
    }

    // Stale heartbeats + stale tasks
    const staleSecs = STALE_THRESHOLD_SECONDS;
    const hbRow = sqliteRows(devDir,
      `SELECT
        (SELECT COUNT(*) FROM workers WHERE heartbeat_epoch > 0 AND (strftime('%s','now') - heartbeat_epoch) > ${staleSecs}) as c0,
        (SELECT COUNT(*) FROM workers WHERE status='in_progress' AND started_at IS NOT NULL AND (julianday('now') - julianday(started_at)) > 1) as c1;`
    );
    let staleHeartbeatCount = 0, staleTasks24hCount = 0;
    if (hbRow.length > 0) {
      staleHeartbeatCount = Number(hbRow[0][0]) || 0;
      staleTasks24hCount = Number(hbRow[0][1]) || 0;
    }

    // Health score
    let healthScore = 100;
    healthScore -= failedPending * 5;
    healthScore -= blockerCount * 10;
    healthScore -= staleHeartbeatCount * 2;
    healthScore -= staleTasks24hCount * 1;
    healthScore = Math.max(0, Math.min(100, healthScore));

    // Worker details
    const workerRows = sqliteRows(devDir,
      "SELECT id, status, task_title, heartbeat_epoch, started_at FROM workers ORDER BY id;"
    );
    const workers = workerRows.map((r) => ({
      id: Number(r[0]) || 0,
      status: r[1] || "idle",
      taskTitle: r[2] || "",
      heartbeatEpoch: r[3] ? Number(r[3]) : null,
      startedAt: r[4] || null,
    }));

    // Recent events from DB
    const eventRows = sqliteRows(devDir,
      "SELECT epoch, event, detail FROM events ORDER BY epoch DESC LIMIT 5;"
    );
    const events = eventRows.reverse().map((r) => {
      const epoch = Number(r[0]) || 0;
      const ts = epoch ? new Date(epoch * 1000).toLocaleTimeString() : "?";
      const event = r[1] || "";
      const detail = r[2] || "";
      return detail ? `${ts} ${event}: ${detail}` : `${ts} ${event}`;
    });

    return {
      pending, claimed, completedCount, failedPending, failedFixed,
      blockerCount, staleHeartbeatCount, staleTasks24hCount, healthScore,
      scrFixed, scrBlocked, scrSuperseded,
      workers, events, source: "sqlite",
    };
  } catch {
    return null;
  }
}

function fetchFromFiles(devDir: string, maxWorkers: number): DashboardData {
  const now = Date.now();

  // Task counts
  const backlog = readFile(join(devDir, "backlog.md"));
  const pending = (backlog.match(/^- \[ \] /gm) || []).length;
  const claimed = (backlog.match(/^- \[>\] /gm) || []).length;

  const completedContent = readFile(join(devDir, "completed.md"));
  const completedLines = completedContent
    .split("\n")
    .filter(
      (l) =>
        l.startsWith("|") && !l.includes("| Date |") && !l.includes("---")
    );
  const completedCount = completedLines.length;

  const failed = readFile(join(devDir, "failed-tasks.md"));
  const failedPending = (failed.match(/\| pending \|/g) || []).length;
  const failedFixed = (failed.match(/\| fixed \|/g) || []).length;

  // Health score inputs
  let staleHeartbeatCount = 0;
  let staleTasks24hCount = 0;
  const staleThresholdMs = STALE_THRESHOLD_SECONDS * 1000;
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;

  const workers: DashboardData["workers"] = [];

  for (let wid = 1; wid <= maxWorkers; wid++) {
    const hbPath = join(devDir, `worker-${wid}.heartbeat`);
    let heartbeatEpoch: number | null = null;
    if (existsSync(hbPath)) {
      const epoch = Number(readFile(hbPath).trim());
      if (epoch) {
        heartbeatEpoch = epoch;
        if (now - epoch * 1000 > staleThresholdMs) {
          staleHeartbeatCount++;
        }
      }
    }

    const taskPath = join(devDir, `current-task-${wid}.md`);
    const taskContent = readFile(taskPath);
    let taskTitle = "";
    let startedAt: string | null = null;
    if (taskContent) {
      const titleMatch = taskContent.match(/^## (.+)/m);
      if (titleMatch) taskTitle = titleMatch[1];
      const startedMatch = taskContent.match(/\*\*Started:\*\* (.+)/);
      if (startedMatch?.[1]) {
        startedAt = startedMatch[1];
        const started = new Date(startedMatch[1]);
        if (!isNaN(started.getTime()) && now - started.getTime() > twentyFourHoursMs) {
          staleTasks24hCount++;
        }
      }
    }

    workers.push({
      id: wid,
      status: taskContent ? "in_progress" : "idle",
      taskTitle,
      heartbeatEpoch,
      startedAt,
    });
  }

  const blockersContent = readFile(join(devDir, "blockers.md"));
  const blockerCount = blockersContent.includes("No active blockers")
    ? 0
    : (blockersContent.match(/^- /gm) || []).length;

  let healthScore = 100;
  healthScore -= failedPending * 5;
  healthScore -= blockerCount * 10;
  healthScore -= staleHeartbeatCount * 2;
  healthScore -= staleTasks24hCount * 1;
  healthScore = Math.max(0, Math.min(100, healthScore));

  // Self-correction stats
  const failedLines = failed
    .split("\n")
    .filter(
      (l) => l.startsWith("|") && !l.includes("Date") && !l.includes("---")
    );
  const scrFixed = failedLines.filter((l) => l.includes("| fixed |")).length;
  const scrBlocked = failedLines.filter((l) => l.includes("| blocked |")).length;
  const scrSuperseded = failedLines.filter((l) => l.includes("| superseded |")).length;

  // Events from file
  const eventsLog = readFile(join(devDir, "events.log"));
  let events: string[] = [];
  if (eventsLog) {
    const eventLines = eventsLog.trim().split("\n").filter(Boolean);
    events = eventLines.slice(-5);
  }

  return {
    pending, claimed, completedCount, failedPending, failedFixed,
    blockerCount, staleHeartbeatCount, staleTasks24hCount, healthScore,
    scrFixed, scrBlocked, scrSuperseded,
    workers, events, source: "files",
  };
}

// ── Render logic ────────────────────────────────────────────────────────────

function renderDashboard(projectDir: string, vars: Record<string, string>) {
  const projectName = vars.SKYNET_PROJECT_NAME;
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const lockPrefix = vars.SKYNET_LOCK_PREFIX || `/tmp/skynet-${projectName}`;
  const maxWorkers = Number(vars.SKYNET_MAX_WORKERS) || 2;
  const now = Date.now();
  const staleThresholdMs = STALE_THRESHOLD_SECONDS * 1000;

  // Try SQLite first, fall back to .md files
  const data = fetchFromSqlite(devDir) ?? fetchFromFiles(devDir, maxWorkers);

  const { pending, claimed, completedCount, failedPending, failedFixed,
    healthScore, scrFixed, scrBlocked, scrSuperseded, events } = data;

  const scrSelfCorrected = scrFixed + scrSuperseded;
  const scrResolved = scrSelfCorrected + scrBlocked;
  const scrRate = scrResolved > 0 ? Math.round((scrSelfCorrected / scrResolved) * 100) : 0;

  // --- Header ---
  const lines: string[] = [];
  const sourceTag = data.source === "files" ? `  ${YELLOW}(file fallback)${RESET}` : "";
  lines.push(
    `  ${BOLD}Skynet Watch${RESET} — ${projectName}  ${DIM}|${RESET}  Health: ${colorHealth(healthScore)}  ${DIM}|${RESET}  ${DIM}${new Date().toLocaleTimeString()}${RESET}${sourceTag}`
  );
  lines.push("");

  // --- Workers Table ---
  lines.push(
    `  ${BOLD}Workers${RESET}  ${DIM}ID    Status    Task                                                             Heartbeat${RESET}`
  );

  for (let wid = 1; wid <= maxWorkers; wid++) {
    const lockFile = `${lockPrefix}-dev-worker-${wid}.lock`;
    const { running } = existsSync(lockFile)
      ? isProcessRunning(lockFile)
      : { running: false };

    const status = running
      ? `${GREEN}active${RESET}`
      : `${DIM}idle${RESET}  `;

    // Current task — prefer DB data, fall back to lock/file
    const dbWorker = data.workers.find((w) => w.id === wid);
    let taskLabel = `${DIM}\u2014${RESET}`;
    if (dbWorker && dbWorker.taskTitle) {
      taskLabel = truncate(dbWorker.taskTitle, 60);
    } else if (data.source === "files") {
      // Already populated from files via workers array
      if (dbWorker?.taskTitle) {
        taskLabel = truncate(dbWorker.taskTitle, 60);
      }
    }

    // Heartbeat age
    let hbAge = `${DIM}\u2014${RESET}`;
    const hbEpoch = dbWorker?.heartbeatEpoch;
    if (hbEpoch) {
      const ageMs = now - hbEpoch * 1000;
      const ageStr = formatDuration(ageMs);
      if (ageMs > staleThresholdMs) {
        hbAge = `${RED}${ageStr} ago${RESET}`;
      } else {
        hbAge = `${GREEN}${ageStr} ago${RESET}`;
      }
    } else if (data.source === "files") {
      // Heartbeat epoch already in workers array from file fetch
      // (null means no heartbeat file found)
    }

    lines.push(`  ${DIM}${wid}${RESET}     ${status}    ${taskLabel.padEnd(65)}${hbAge}`);
  }

  lines.push("");

  // --- Task Summary ---
  lines.push(
    `  ${BOLD}Tasks${RESET}  ${GREEN}${pending} pending${RESET}  ${YELLOW}${claimed} claimed${RESET}  ${GREEN}${completedCount} completed${RESET}  ${failedPending > 0 ? RED : DIM}${failedPending} failed${RESET}  ${DIM}${failedFixed} fixed${RESET}`
  );

  // --- Self-Correction Rate ---
  const rateColor = scrRate >= 80 ? GREEN : scrRate >= 50 ? YELLOW : RED;
  lines.push(
    `  ${BOLD}Self-correction${RESET}  ${rateColor}${scrRate}%${RESET}  ${DIM}(${scrFixed} fixed + ${scrSuperseded} routed around / ${scrResolved} resolved)${RESET}`
  );

  lines.push("");

  // --- Last 5 Events ---
  lines.push(`  ${BOLD}Recent Events${RESET}`);
  if (events.length > 0) {
    for (const evt of events) {
      lines.push(`  ${DIM}${evt}${RESET}`);
    }
  } else {
    lines.push(`  ${DIM}No events recorded${RESET}`);
  }

  lines.push("");
  lines.push(`  ${DIM}Press Ctrl+C to exit${RESET}`);

  // Clear screen and render
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(lines.join("\n") + "\n");
}

export async function watchCommand(options: WatchOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  // Render immediately, then every 3 seconds
  renderDashboard(projectDir, vars);

  const interval = setInterval(() => {
    try {
      renderDashboard(projectDir, vars);
    } catch (err) {
      // If something goes wrong reading files, keep going
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\n  ${RED}Error: ${msg}${RESET}\n`);
    }
  }, 3000);

  // Clean exit on SIGINT / SIGTERM
  const cleanup = () => {
    clearInterval(interval);
    process.stdout.write("\x1b[2J\x1b[H");
    console.log("\n  Skynet watch stopped.\n");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
