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
    console.log(`\n  Skynet Pipeline Status (${projectName}) — PAUSED${pauseInfo}\n`);
  } else {
    console.log(`\n  Skynet Pipeline Status (${projectName})\n`);
  }

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

  // --- Heartbeat staleness + task age for health score ---
  const staleThresholdMs = 45 * 60 * 1000;
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  for (let wid = 1; wid <= 2; wid++) {
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
  let blockerCount = 0;
  if (blockers.includes("No active blockers")) {
    console.log("  Blockers: None");
  } else {
    blockerCount = (blockers.match(/^- /gm) || []).length;
    if (blockerCount > 0) {
      console.log(`  Blockers: ${blockerCount} active`);
    } else {
      console.log("  Blockers: None");
    }
  }

  // --- Health Score ---
  let healthScore = 100;
  healthScore -= failedPending * 5;
  healthScore -= blockerCount * 10;
  healthScore -= staleHeartbeatCount * 2;
  healthScore -= staleTasks24hCount * 1;
  healthScore = Math.max(0, Math.min(100, healthScore));

  const healthLabel = healthScore > 80 ? "Good" : healthScore > 50 ? "Degraded" : "Critical";
  console.log(`\n  Health Score: ${healthScore}/100 (${healthLabel})`);

  // --- Self-Correction Rate ---
  const failedLines = failed
    .split("\n")
    .filter((l) => l.startsWith("|") && !l.includes("Date") && !l.includes("---"));
  const scrFixed = failedLines.filter((l) => l.includes("| fixed |")).length;
  const scrBlocked = failedLines.filter((l) => l.includes("| blocked |")).length;
  const scrSuperseded = failedLines.filter((l) => l.includes("| superseded |")).length;
  const scrTotal = scrFixed + scrBlocked + scrSuperseded;
  const scrRate = scrTotal > 0 ? Math.round((scrFixed / scrTotal) * 100) : 0;
  console.log(`  Self-correction rate: ${scrRate}% (${scrFixed}/${scrTotal} failures auto-fixed)`);

  // --- Mission Progress ---
  const missionRaw = readFile(join(devDir, "mission.md"));
  if (missionRaw) {
    const scMatch = missionRaw.match(/## Success Criteria\s*\n([\s\S]*?)(?:\n## |\n*$)/i);
    if (scMatch) {
      const criteriaLines = scMatch[1]
        .split("\n")
        .filter((l) => /^\d+\.\s/.test(l.trim()));

      if (criteriaLines.length > 0) {
        // Gather evaluation inputs
        const failedContent = readFile(join(devDir, "failed-tasks.md"));
        const totalFailedLines = failedContent
          .split("\n")
          .filter((l) => l.startsWith("|") && !l.includes("Date") && !l.includes("---"));
        const fixedCount = totalFailedLines.filter((l) => l.includes("| fixed |")).length;
        const totalFailed = totalFailedLines.length;

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
              if (totalFailed === 0) { status = "partial"; evidence = "No failures yet"; }
              else {
                const pct = Math.round((fixedCount / totalFailed) * 100);
                if (pct >= 95) { status = "met"; evidence = `${pct}% fix rate`; }
                else if (pct >= 50) { status = "partial"; evidence = `${pct}% fix rate`; }
                else { status = "not-met"; evidence = `${pct}% fix rate`; }
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

        console.log(`\n  Mission Progress: ${metCount}/${criteriaLines.length} met, ${partialCount} partial`);
        for (const sl of summaryLines) {
          console.log(sl);
        }
      }
    }
  }

  console.log("");
}
