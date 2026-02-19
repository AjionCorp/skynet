import { readFileSync, existsSync, statSync } from "fs";
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

function isProcessRunning(lockFile: string): boolean {
  try {
    const pid = readFileSync(lockFile, "utf-8").trim();
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function statusCommand(options: StatusOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);

  const projectName = vars.SKYNET_PROJECT_NAME;
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const lockPrefix = vars.SKYNET_LOCK_PREFIX || `/tmp/skynet-${projectName}`;

  console.log(`\n  Skynet Pipeline Status (${projectName})\n`);

  // Workers
  const workers = [
    "dev-worker-1", "dev-worker-2", "task-fixer", "project-driver",
    "sync-runner", "ui-tester", "feature-validator", "health-check",
    "auth-refresh", "watchdog",
  ];

  let running = 0;
  const total = workers.length;

  for (const w of workers) {
    const lockFile = `${lockPrefix}-${w}.lock`;
    if (existsSync(lockFile) && isProcessRunning(lockFile)) {
      running++;
    }
  }

  console.log(`  Workers:   ${running}/${total} running`);

  // Backlog
  const backlog = readFile(join(devDir, "backlog.md"));
  const pending = (backlog.match(/^- \[ \] /gm) || []).length;
  const claimed = (backlog.match(/^- \[>\] /gm) || []).length;
  console.log(`  Backlog:   ${pending} pending, ${claimed} claimed`);

  // Completed
  const completed = readFile(join(devDir, "completed.md"));
  const completedLines = completed
    .split("\n")
    .filter((l) => l.startsWith("|") && !l.includes("Date") && !l.includes("---"));
  console.log(`  Completed: ${completedLines.length} total`);

  // Failed
  const failed = readFile(join(devDir, "failed-tasks.md"));
  const failedPending = (failed.match(/\| pending \|/g) || []).length;
  console.log(`  Failed:    ${failedPending} pending`);

  // Auth
  const tokenCache = vars.SKYNET_AUTH_TOKEN_CACHE || `${lockPrefix}-claude-token`;
  if (existsSync(tokenCache)) {
    const age = Date.now() - statSync(tokenCache).mtimeMs;
    const mins = Math.floor(age / 60000);
    console.log(`  Auth:      OK (token cached ${mins}m ago)`);
  } else {
    console.log("  Auth:      No token cached");
  }

  // Blockers
  const blockers = readFile(join(devDir, "blockers.md"));
  if (blockers.includes("No active blockers")) {
    console.log("  Blockers:  None");
  } else {
    const blockerCount = (blockers.match(/^- /gm) || []).length;
    console.log(`  Blockers:  ${blockerCount} active`);
  }

  // Current task
  const currentTask = readFile(join(devDir, "current-task.md"));
  const titleMatch = currentTask.match(/^## (.+)/m);
  const statusMatch = currentTask.match(/\*\*Status:\*\* (\w+)/);
  if (statusMatch?.[1] === "in_progress" && titleMatch?.[1]) {
    console.log(`  Task:      ${titleMatch[1]}`);
  } else {
    console.log("  Task:      Idle");
  }

  console.log("");
}
