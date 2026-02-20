import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";
import { loadConfig } from "../utils/loadConfig";

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

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function isProcessRunning(lockFile: string): { running: boolean; pid: string } {
  try {
    const pid = readFileSync(lockFile, "utf-8").trim();
    if (!/^\d+$/.test(pid)) return { running: false, pid: "" };
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    return { running: true, pid };
  } catch {
    return { running: false, pid: "" };
  }
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

function colorHealth(score: number): string {
  if (score > 80) return `${GREEN}${score}/100${RESET}`;
  if (score > 50) return `${YELLOW}${score}/100${RESET}`;
  return `${RED}${score}/100${RESET}`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max) + "..." : str;
}

function renderDashboard(projectDir: string, vars: Record<string, string>) {
  const projectName = vars.SKYNET_PROJECT_NAME;
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const lockPrefix = vars.SKYNET_LOCK_PREFIX || `/tmp/skynet-${projectName}`;
  const maxWorkers = Number(vars.SKYNET_MAX_WORKERS) || 2;
  const now = Date.now();

  // --- Task Counts ---
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

  // --- Health Score ---
  let staleHeartbeatCount = 0;
  let staleTasks24hCount = 0;
  const staleThresholdMs = 45 * 60 * 1000;
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;

  for (let wid = 1; wid <= maxWorkers; wid++) {
    const hbPath = join(devDir, `worker-${wid}.heartbeat`);
    if (existsSync(hbPath)) {
      const epoch = Number(readFile(hbPath).trim());
      if (epoch && now - epoch * 1000 > staleThresholdMs) {
        staleHeartbeatCount++;
      }
    }
    const taskPath = join(devDir, `current-task-${wid}.md`);
    const taskContent = readFile(taskPath);
    if (taskContent) {
      const startedMatch = taskContent.match(/\*\*Started:\*\* (.+)/);
      if (startedMatch?.[1]) {
        const started = new Date(startedMatch[1]);
        if (
          !isNaN(started.getTime()) &&
          now - started.getTime() > twentyFourHoursMs
        ) {
          staleTasks24hCount++;
        }
      }
    }
  }

  const blockers = readFile(join(devDir, "blockers.md"));
  const blockerCount = blockers.includes("No active blockers")
    ? 0
    : (blockers.match(/^- /gm) || []).length;

  let healthScore = 100;
  healthScore -= failedPending * 5;
  healthScore -= blockerCount * 10;
  healthScore -= staleHeartbeatCount * 2;
  healthScore -= staleTasks24hCount * 1;
  healthScore = Math.max(0, Math.min(100, healthScore));

  // --- Header ---
  const lines: string[] = [];
  lines.push(
    `  ${BOLD}Skynet Watch${RESET} — ${projectName}  ${DIM}|${RESET}  Health: ${colorHealth(healthScore)}  ${DIM}|${RESET}  ${DIM}${new Date().toLocaleTimeString()}${RESET}`
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

    // Current task
    const taskPath = join(devDir, `current-task-${wid}.md`);
    const taskContent = readFile(taskPath);
    let taskLabel = `${DIM}—${RESET}`;
    if (taskContent) {
      const titleMatch = taskContent.match(/^## (.+)/m);
      if (titleMatch) {
        taskLabel = truncate(titleMatch[1], 60);
      }
    }

    // Heartbeat age
    const hbPath = join(devDir, `worker-${wid}.heartbeat`);
    let hbAge = `${DIM}—${RESET}`;
    if (existsSync(hbPath)) {
      const epoch = Number(readFile(hbPath).trim());
      if (epoch) {
        const ageMs = now - epoch * 1000;
        const ageStr = formatDuration(ageMs);
        if (ageMs > staleThresholdMs) {
          hbAge = `${RED}${ageStr} ago${RESET}`;
        } else {
          hbAge = `${GREEN}${ageStr} ago${RESET}`;
        }
      }
    }

    lines.push(`  ${DIM}${wid}${RESET}     ${status}    ${taskLabel.padEnd(65)}${hbAge}`);
  }

  lines.push("");

  // --- Task Summary ---
  lines.push(
    `  ${BOLD}Tasks${RESET}  ${GREEN}${pending} pending${RESET}  ${YELLOW}${claimed} claimed${RESET}  ${GREEN}${completedCount} completed${RESET}  ${failedPending > 0 ? RED : DIM}${failedPending} failed${RESET}  ${DIM}${failedFixed} fixed${RESET}`
  );

  // --- Self-Correction Rate ---
  const failedLines = failed
    .split("\n")
    .filter(
      (l) =>
        l.startsWith("|") && !l.includes("Date") && !l.includes("---")
    );
  const scrFixed = failedLines.filter((l) => l.includes("| fixed |")).length;
  const scrBlocked = failedLines.filter((l) =>
    l.includes("| blocked |")
  ).length;
  const scrSuperseded = failedLines.filter((l) =>
    l.includes("| superseded |")
  ).length;
  const scrSelfCorrected = scrFixed + scrSuperseded;
  const scrResolved = scrSelfCorrected + scrBlocked;
  const scrRate =
    scrResolved > 0 ? Math.round((scrSelfCorrected / scrResolved) * 100) : 0;

  const rateColor = scrRate >= 80 ? GREEN : scrRate >= 50 ? YELLOW : RED;
  lines.push(
    `  ${BOLD}Self-correction${RESET}  ${rateColor}${scrRate}%${RESET}  ${DIM}(${scrFixed} fixed + ${scrSuperseded} routed around / ${scrResolved} resolved)${RESET}`
  );

  lines.push("");

  // --- Last 5 Events ---
  lines.push(`  ${BOLD}Recent Events${RESET}`);
  const eventsLog = readFile(join(devDir, "events.log"));
  if (eventsLog) {
    const eventLines = eventsLog.trim().split("\n").filter(Boolean);
    const last5 = eventLines.slice(-5);
    for (const evt of last5) {
      // Events format: timestamp|type|message or similar
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

  // Clean exit on SIGINT
  process.on("SIGINT", () => {
    clearInterval(interval);
    process.stdout.write("\x1b[2J\x1b[H");
    console.log("\n  Skynet watch stopped.\n");
    process.exit(0);
  });
}
