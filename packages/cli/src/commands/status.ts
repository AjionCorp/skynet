import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";

interface StatusOptions {
  dir?: string;
}

function loadConfig(projectDir: string): Record<string, string> {
  const configPath = join(projectDir, ".dev/skynet.config.sh");
  if (!existsSync(configPath)) {
    throw new Error(`skynet.config.sh not found. Run 'skynet init' first.`);
  }

  const content = readFileSync(configPath, "utf-8");
  const vars: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const match = line.match(/^export\s+(\w+)="(.*)"/);
    if (match) {
      let value = match[2];
      value = value.replace(/\$\{?(\w+)\}?/g, (_, key) => vars[key] || process.env[key] || "");
      vars[match[1]] = value;
    }
  }

  return vars;
}

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
    // Validate PID is numeric to prevent shell injection
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

  const projectName = vars.SKYNET_PROJECT_NAME;
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const lockPrefix = vars.SKYNET_LOCK_PREFIX || `/tmp/skynet-${projectName}`;

  console.log(`\n  Skynet Pipeline Status (${projectName})\n`);

  // --- Task Counts ---
  const backlog = readFile(join(devDir, "backlog.md"));
  const pending = (backlog.match(/^- \[ \] /gm) || []).length;
  const claimed = (backlog.match(/^- \[>\] /gm) || []).length;

  const completedContent = readFile(join(devDir, "completed.md"));
  const completedLines = completedContent
    .split("\n")
    .filter((l) => l.startsWith("|") && !l.includes("| Date |") && !l.includes("---"));
  const completedCount = completedLines.length;

  const failed = readFile(join(devDir, "failed-tasks.md"));
  const failedPending = (failed.match(/\| pending \|/g) || []).length;
  const failedFixed = (failed.match(/\| fixed \|/g) || []).length;

  console.log("  Tasks:");
  console.log(`    Pending:    ${pending}`);
  console.log(`    Claimed:    ${claimed}`);
  console.log(`    Completed:  ${completedCount}`);
  console.log(`    Failed:     ${failedPending} pending, ${failedFixed} fixed`);

  // --- Current Tasks (per-worker) ---
  console.log("\n  Current Tasks:");

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

  let hasActiveTasks = false;
  for (const file of taskFiles) {
    const content = readFile(join(devDir, file));
    if (!content) continue;

    const titleMatch = content.match(/^## (.+)/m);
    const statusMatch = content.match(/\*\*Status:\*\* (\w+)/);
    const startedMatch = content.match(/\*\*Started:\*\* (.+)/);
    const workerMatch = content.match(/\*\*Worker:\*\* (\w+)/);

    const taskStatus = statusMatch?.[1] || "unknown";
    const taskTitle = titleMatch?.[1] || "Unknown";
    const label = workerMatch?.[1] ? `Worker ${workerMatch[1]}` : file.replace(".md", "");

    if (taskStatus === "in_progress" || taskStatus === "completed") {
      hasActiveTasks = true;
      let duration = "";
      if (startedMatch?.[1]) {
        const started = new Date(startedMatch[1]);
        if (!isNaN(started.getTime())) {
          duration = ` (${formatDuration(Date.now() - started.getTime())})`;
        }
      }

      // Truncate long task names
      const maxLen = 60;
      const shortTitle = taskTitle.length > maxLen
        ? taskTitle.substring(0, maxLen) + "..."
        : taskTitle;

      console.log(`    ${label}: [${taskStatus}] ${shortTitle}${duration}`);
    }
  }

  if (!hasActiveTasks) {
    console.log("    Idle — no active tasks");
  }

  // --- Workers ---
  const workers = [
    "dev-worker-1", "dev-worker-2", "task-fixer", "project-driver",
    "sync-runner", "ui-tester", "feature-validator", "health-check",
    "auth-refresh", "watchdog",
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

  console.log(`\n  Workers: ${runningCount}/${workers.length}`);
  if (workerStatuses.length > 0) {
    for (const ws of workerStatuses) {
      const icon = ws.running ? "running" : "stale";
      const pidLabel = ws.pid ? ` (PID ${ws.pid})` : "";
      console.log(`    ${ws.name}: ${icon}${pidLabel}`);
    }
  } else {
    console.log("    No lock files found");
  }

  // --- Last Activity ---
  const lastActivity = getLastActivityTimestamp(devDir);
  if (lastActivity) {
    const ago = formatDuration(Date.now() - lastActivity.getTime());
    console.log(`\n  Last Activity: ${ago} ago`);
  }

  // --- Recent Completions ---
  const recent = parseRecentCompletions(completedContent, 3);
  if (recent.length > 0) {
    console.log("\n  Recent Completions:");
    for (const entry of recent) {
      console.log(`    ${entry}`);
    }
  }

  // --- Auth ---
  const tokenCache = vars.SKYNET_AUTH_TOKEN_CACHE || `${lockPrefix}-claude-token`;
  if (existsSync(tokenCache)) {
    const age = Date.now() - statSync(tokenCache).mtimeMs;
    const mins = Math.floor(age / 60000);
    console.log(`\n  Auth: OK (token cached ${mins}m ago)`);
  } else {
    console.log("\n  Auth: No token cached");
  }

  // --- Blockers ---
  const blockers = readFile(join(devDir, "blockers.md"));
  if (blockers.includes("No active blockers")) {
    console.log("  Blockers: None");
  } else {
    const blockerCount = (blockers.match(/^- /gm) || []).length;
    if (blockerCount > 0) {
      console.log(`  Blockers: ${blockerCount} active`);
    } else {
      console.log("  Blockers: None");
    }
  }

  console.log("");
}
