import { readFileSync, existsSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";
import { loadConfig } from "../utils/loadConfig";

interface DoctorOptions {
  dir?: string;
  fix?: boolean;
}

function getToolVersion(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], timeout: 10000 })
      .toString()
      .trim()
      .split("\n")[0];
  } catch {
    return null;
  }
}

function isProcessRunning(lockFile: string): { running: boolean; pid: string } {
  try {
    // Support dir-based locks (lockFile/pid) and legacy file-based locks
    let pid: string;
    try {
      pid = readFileSync(join(lockFile, "pid"), "utf-8").trim();
    } catch {
      pid = readFileSync(lockFile, "utf-8").trim();
    }
    if (!/^\d+$/.test(pid)) return { running: false, pid: "" };
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    return { running: true, pid };
  } catch {
    return { running: false, pid: "" };
  }
}

function readFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

type Status = "PASS" | "WARN" | "FAIL";

function label(status: Status): string {
  switch (status) {
    case "PASS": return "[PASS]";
    case "WARN": return "[WARN]";
    case "FAIL": return "[FAIL]";
  }
}

export async function doctorCommand(options: DoctorOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const results: { name: string; status: Status }[] = [];
  const fixing = options.fix === true;
  let fixCount = 0;

  console.log(`\n  Skynet Doctor — ${projectDir}${fixing ? " (auto-fix enabled)" : ""}\n`);

  // --- (1) Required Tools ---
  console.log("  Required Tools:");

  const tools: { name: string; cmd: string; required: boolean }[] = [
    { name: "git", cmd: "git --version", required: true },
    { name: "node", cmd: "node --version", required: true },
    { name: "pnpm", cmd: "pnpm --version", required: true },
    { name: "shellcheck", cmd: "shellcheck --version", required: false },
  ];

  let allToolsFound = true;
  let requiredToolMissing = false;

  for (const tool of tools) {
    const version = getToolVersion(tool.cmd);
    if (version) {
      console.log(`    ${tool.name}: ${version}`);
    } else {
      console.log(`    ${tool.name}: MISSING`);
      allToolsFound = false;
      if (tool.required) requiredToolMissing = true;
    }
  }

  if (requiredToolMissing) {
    results.push({ name: "Required Tools", status: "FAIL" });
  } else if (!allToolsFound) {
    results.push({ name: "Required Tools", status: "WARN" });
  } else {
    results.push({ name: "Required Tools", status: "PASS" });
  }

  // --- (2) skynet.config.sh ---
  console.log("\n  Config:");

  const configPath = join(projectDir, ".dev/skynet.config.sh");
  const vars = loadConfig(projectDir);

  if (!vars) {
    console.log(`    skynet.config.sh: NOT FOUND at ${configPath}`);
    results.push({ name: "Config", status: "FAIL" });
  } else {
    const projectName = vars.SKYNET_PROJECT_NAME;
    if (projectName) {
      console.log(`    skynet.config.sh: OK (project: ${projectName})`);
      results.push({ name: "Config", status: "PASS" });
    } else {
      console.log("    skynet.config.sh: found but SKYNET_PROJECT_NAME is missing");
      results.push({ name: "Config", status: "WARN" });
    }
  }

  // --- (3) Scripts Directory ---
  console.log("\n  Scripts:");

  const devDir = vars?.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const scriptsDir = `${devDir}/scripts`;

  const expectedScripts = [
    "dev-worker.sh", "watchdog.sh", "task-fixer.sh", "health-check.sh",
    "sync-runner.sh", "project-driver.sh", "feature-validator.sh",
  ];

  if (!existsSync(scriptsDir)) {
    console.log(`    scripts/ directory: NOT FOUND at ${scriptsDir}`);
    results.push({ name: "Scripts", status: "FAIL" });
  } else {
    let missing = 0;
    for (const script of expectedScripts) {
      const scriptPath = join(scriptsDir, script);
      if (existsSync(scriptPath)) {
        console.log(`    ${script}: OK`);
      } else {
        console.log(`    ${script}: MISSING`);
        missing++;
      }
    }

    if (missing === 0) {
      results.push({ name: "Scripts", status: "PASS" });
    } else if (missing === expectedScripts.length) {
      results.push({ name: "Scripts", status: "FAIL" });
    } else {
      results.push({ name: "Scripts", status: "WARN" });
    }
  }

  // --- (4) Agent Availability ---
  console.log("\n  Agents:");

  const agents: { name: string; cmd: string }[] = [
    { name: "claude", cmd: "claude --version" },
    { name: "codex", cmd: "codex --version" },
  ];

  let agentsAvailable = 0;

  for (const agent of agents) {
    const version = getToolVersion(agent.cmd);
    if (version) {
      console.log(`    ${agent.name}: ${version}`);
      agentsAvailable++;
    } else {
      console.log(`    ${agent.name}: NOT AVAILABLE`);
    }
  }

  if (agentsAvailable === 0) {
    results.push({ name: "Agents", status: "FAIL" });
  } else if (agentsAvailable < agents.length) {
    results.push({ name: "Agents", status: "WARN" });
  } else {
    results.push({ name: "Agents", status: "PASS" });
  }

  // --- (5) .dev/ State Files ---
  console.log("\n  State Files:");

  const stateFiles = [
    "backlog.md", "completed.md", "failed-tasks.md", "mission.md",
  ];

  let stateFound = 0;

  for (const file of stateFiles) {
    const filePath = join(devDir, file);
    if (existsSync(filePath)) {
      console.log(`    ${file}: OK`);
      stateFound++;
    } else {
      console.log(`    ${file}: MISSING`);
    }
  }

  if (stateFound === stateFiles.length) {
    results.push({ name: "State Files", status: "PASS" });
  } else if (stateFound === 0) {
    results.push({ name: "State Files", status: "FAIL" });
  } else {
    results.push({ name: "State Files", status: "WARN" });
  }

  // --- (6) Worker PID Lock Files ---
  console.log("\n  Workers:");

  const projectName = vars?.SKYNET_PROJECT_NAME;
  const lockPrefix = vars?.SKYNET_LOCK_PREFIX || (projectName ? `/tmp/skynet-${projectName}` : null);

  const workers = [
    "dev-worker-1", "dev-worker-2", "task-fixer", "project-driver",
    "sync-runner", "ui-tester", "feature-validator", "health-check",
    "auth-refresh", "watchdog",
  ];

  if (!lockPrefix) {
    console.log("    Cannot check — no lock prefix (config missing)");
    results.push({ name: "Workers", status: "WARN" });
  } else {
    let running = 0;
    let stale = 0;

    for (const w of workers) {
      const lockFile = `${lockPrefix}-${w}.lock`;
      if (existsSync(lockFile)) {
        const { running: isRunning, pid } = isProcessRunning(lockFile);
        if (isRunning) {
          console.log(`    ${w}: ACTIVE (PID ${pid})`);
          running++;
        } else {
          console.log(`    ${w}: STALE lock`);
          stale++;
        }
      }
    }

    if (running === 0 && stale === 0) {
      console.log("    No lock files found (pipeline idle)");
      results.push({ name: "Workers", status: "PASS" });
    } else if (stale > 0 && running === 0) {
      results.push({ name: "Workers", status: "WARN" });
    } else {
      results.push({ name: "Workers", status: "PASS" });
    }
  }

  // --- (7) Git Repo ---
  console.log("\n  Git:");

  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();

    const status = execSync("git status --porcelain", {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();

    const isDirty = status.length > 0;
    console.log(`    Branch: ${branch}`);
    console.log(`    Status: ${isDirty ? "dirty" : "clean"}`);

    results.push({ name: "Git", status: isDirty ? "WARN" : "PASS" });
  } catch {
    console.log("    Not a git repository");
    results.push({ name: "Git", status: "FAIL" });
  }

  // --- (8) Worker Count Match ---
  console.log("\n  Worker Count Match:");

  const maxWorkers = Number(vars?.SKYNET_MAX_WORKERS) || 0;

  if (!maxWorkers) {
    console.log("    Cannot check — SKYNET_MAX_WORKERS not configured");
    results.push({ name: "Worker Count Match", status: "WARN" });
  } else if (!lockPrefix) {
    console.log("    Cannot check — no lock prefix (config missing)");
    results.push({ name: "Worker Count Match", status: "WARN" });
  } else {
    let runningDevWorkers = 0;
    // Scan beyond maxWorkers to detect extras
    const scanLimit = maxWorkers + 10;
    for (let n = 1; n <= scanLimit; n++) {
      const lockFile = `${lockPrefix}-dev-worker-${n}.lock`;
      if (existsSync(lockFile) && isProcessRunning(lockFile).running) {
        runningDevWorkers++;
      }
    }

    console.log(`    Configured max: ${maxWorkers}, Running: ${runningDevWorkers}`);
    if (runningDevWorkers > maxWorkers) {
      console.log("    More workers running than configured max");
      results.push({ name: "Worker Count Match", status: "WARN" });
    } else {
      results.push({ name: "Worker Count Match", status: "PASS" });
    }
  }

  // --- (9) Orphaned Worktrees ---
  console.log("\n  Orphaned Worktrees:");

  try {
    const wtOutput = execSync("git worktree list --porcelain", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse worktree entries
    const worktrees: { path: string; branch: string }[] = [];
    let currentWtPath = "";
    for (const line of wtOutput.split("\n")) {
      const pathMatch = line.match(/^worktree (.+)/);
      if (pathMatch) {
        currentWtPath = pathMatch[1];
      }
      const branchMatch = line.match(/^branch refs\/heads\/(.+)/);
      if (branchMatch && currentWtPath) {
        worktrees.push({ path: currentWtPath, branch: branchMatch[1] });
        currentWtPath = "";
      }
    }

    // Determine active worktree paths (main project dir + running worker worktrees)
    const activeWorktreePaths = new Set<string>();
    activeWorktreePaths.add(resolve(projectDir));

    if (lockPrefix && projectName) {
      const wtScanMax = (maxWorkers || 4) + 10;
      for (let n = 1; n <= wtScanMax; n++) {
        const lockFile = `${lockPrefix}-dev-worker-${n}.lock`;
        if (existsSync(lockFile) && isProcessRunning(lockFile).running) {
          activeWorktreePaths.add(`/tmp/skynet-${projectName}-worktree-w${n}`);
        }
      }
    }

    let orphanedCount = 0;
    for (const wt of worktrees) {
      if (!activeWorktreePaths.has(wt.path)) {
        console.log(`    Orphaned: ${wt.path} (${wt.branch})`);
        orphanedCount++;
      }
    }

    if (orphanedCount === 0) {
      console.log("    No orphaned worktrees");
      results.push({ name: "Orphaned Worktrees", status: "PASS" });
    } else {
      console.log(`    ${orphanedCount} orphaned worktree(s) found`);
      if (fixing) {
        try {
          execSync("git worktree prune", { cwd: projectDir, stdio: "ignore" });
          console.log("    Fixed: ran git worktree prune");
          fixCount += orphanedCount;
        } catch {
          console.log("    Could not run git worktree prune");
        }
      }
      results.push({ name: "Orphaned Worktrees", status: "WARN" });
    }
  } catch {
    console.log("    Cannot check — git worktree list failed");
    results.push({ name: "Orphaned Worktrees", status: "WARN" });
  }

  // --- (10) Backlog Integrity ---
  console.log("\n  Backlog Integrity:");

  const backlogPath = join(devDir, "backlog.md");

  if (!existsSync(backlogPath)) {
    console.log("    Cannot check — backlog.md not found");
    results.push({ name: "Backlog Integrity", status: "WARN" });
  } else {
    const backlogContent = readFile(backlogPath);
    const backlogLines = backlogContent.split("\n");
    let integrityIssues = 0;

    // Check for duplicate pending task titles
    const pendingTitles: string[] = [];
    const claimedTitles: string[] = [];

    for (const line of backlogLines) {
      if (line.startsWith("- [ ] ")) {
        const title = line.replace(/^- \[ \] /, "").split(" — ")[0].trim();
        pendingTitles.push(title);
      } else if (line.startsWith("- [>] ")) {
        const title = line.replace(/^- \[>\] /, "").split(" — ")[0].trim();
        claimedTitles.push(title);
      }
    }

    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const title of pendingTitles) {
      if (seen.has(title)) {
        duplicates.add(title);
      }
      seen.add(title);
    }

    if (duplicates.size > 0) {
      for (const dup of duplicates) {
        console.log(`    Duplicate pending task: ${dup}`);
      }
      integrityIssues += duplicates.size;
    }

    // Check claimed tasks have matching current-task-N.md in in_progress state
    const inProgressTitles = new Set<string>();
    try {
      const devEntries = readdirSync(devDir);
      for (const entry of devEntries) {
        if (entry.match(/^current-task(-\d+)?\.md$/)) {
          const content = readFile(join(devDir, entry));
          const titleMatch = content.match(/^## (.+)/m);
          const statusMatch = content.match(/\*\*Status:\*\* (\w+)/);
          if (titleMatch && statusMatch?.[1] === "in_progress") {
            inProgressTitles.add(titleMatch[1].trim());
          }
        }
      }
    } catch {
      // devDir may not be readable
    }

    const orphanedClaimed: string[] = [];
    for (const claimed of claimedTitles) {
      if (!inProgressTitles.has(claimed)) {
        console.log(`    Claimed task without in_progress file: ${claimed}`);
        orphanedClaimed.push(claimed);
        integrityIssues++;
      }
    }

    if (integrityIssues === 0) {
      console.log("    No integrity issues found");
      results.push({ name: "Backlog Integrity", status: "PASS" });
    } else {
      if (fixing && orphanedClaimed.length > 0) {
        let updatedBacklog = backlogContent;
        for (const title of orphanedClaimed) {
          // Replace [>] with [ ] for lines matching this claimed title
          const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`^(- )\\[>\\]( ${escaped})`, "m");
          updatedBacklog = updatedBacklog.replace(re, "$1[ ]$2");
        }
        try {
          writeFileSync(backlogPath, updatedBacklog, "utf-8");
          console.log(`    Fixed: reset ${orphanedClaimed.length} orphaned claimed task(s) to pending`);
          fixCount += orphanedClaimed.length;
        } catch {
          console.log("    Could not write backlog.md");
        }
      }
      results.push({ name: "Backlog Integrity", status: "WARN" });
    }
  }

  // --- (11) Stale Heartbeats ---
  console.log("\n  Stale Heartbeats:");

  const staleMinutes = Number(vars?.SKYNET_STALE_MINUTES) || 45;
  const staleThresholdMs = staleMinutes * 60 * 1000;
  const now = Date.now();

  let staleCount = 0;
  let heartbeatTotal = 0;
  const heartbeatScanMax = maxWorkers || 10;
  const staleHeartbeatPaths: string[] = [];

  for (let n = 1; n <= heartbeatScanMax; n++) {
    const hbPath = join(devDir, `worker-${n}.heartbeat`);
    if (existsSync(hbPath)) {
      heartbeatTotal++;
      const epoch = Number(readFile(hbPath).trim());
      if (epoch) {
        const ageMs = now - epoch * 1000;
        const ageMin = Math.round(ageMs / 60000);
        if (ageMs > staleThresholdMs) {
          console.log(`    Worker ${n}: stale (${ageMin}m old, threshold: ${staleMinutes}m)`);
          staleHeartbeatPaths.push(hbPath);
          staleCount++;
        } else {
          console.log(`    Worker ${n}: OK (${ageMin}m old)`);
        }
      } else {
        console.log(`    Worker ${n}: invalid heartbeat file`);
        staleHeartbeatPaths.push(hbPath);
        staleCount++;
      }
    }
  }

  if (heartbeatTotal === 0) {
    console.log("    No heartbeat files found (pipeline idle)");
    results.push({ name: "Stale Heartbeats", status: "PASS" });
  } else if (staleCount > 0) {
    if (fixing) {
      for (const hbPath of staleHeartbeatPaths) {
        try {
          unlinkSync(hbPath);
          console.log(`    Fixed: deleted ${hbPath}`);
          fixCount++;
        } catch {
          console.log(`    Could not delete ${hbPath}`);
        }
      }
    }
    results.push({ name: "Stale Heartbeats", status: "WARN" });
  } else {
    results.push({ name: "Stale Heartbeats", status: "PASS" });
  }

  // --- (12) Config Completeness ---
  console.log("\n  Config Completeness:");

  const requiredVars = [
    "SKYNET_PROJECT_NAME",
    "SKYNET_PROJECT_DIR",
    "SKYNET_DEV_DIR",
    "SKYNET_LOCK_PREFIX",
    "SKYNET_MAIN_BRANCH",
    "SKYNET_MAX_WORKERS",
    "SKYNET_STALE_MINUTES",
    "SKYNET_BRANCH_PREFIX",
  ];

  if (!vars) {
    console.log("    Cannot check — config not loaded");
    results.push({ name: "Config Completeness", status: "FAIL" });
  } else {
    const configDefaults: Record<string, string> = {
      SKYNET_PROJECT_NAME: "my-project",
      SKYNET_PROJECT_DIR: projectDir,
      SKYNET_DEV_DIR: "$SKYNET_PROJECT_DIR/.dev",
      SKYNET_LOCK_PREFIX: "/tmp/skynet-${SKYNET_PROJECT_NAME}",
      SKYNET_MAIN_BRANCH: "main",
      SKYNET_MAX_WORKERS: "4",
      SKYNET_STALE_MINUTES: "45",
      SKYNET_BRANCH_PREFIX: "dev/",
    };

    let missingVars = 0;
    const missingKeys: string[] = [];
    for (const key of requiredVars) {
      const value = vars[key];
      if (!value || value.trim().length === 0) {
        console.log(`    ${key}: MISSING or empty`);
        missingVars++;
        missingKeys.push(key);
      } else {
        console.log(`    ${key}: OK`);
      }
    }

    if (missingVars === 0) {
      results.push({ name: "Config Completeness", status: "PASS" });
    } else {
      if (fixing && missingKeys.length > 0) {
        const lines: string[] = [];
        for (const key of missingKeys) {
          const def = configDefaults[key] || "";
          lines.push(`export ${key}="${def}"`);
        }
        try {
          const existing = readFileSync(configPath, "utf-8");
          writeFileSync(configPath, existing.trimEnd() + "\n" + lines.join("\n") + "\n", "utf-8");
          console.log(`    Fixed: appended ${missingKeys.length} default config var(s)`);
          fixCount += missingKeys.length;
        } catch {
          console.log("    Could not write to config file");
        }
      }
      results.push({ name: "Config Completeness", status: "FAIL" });
    }
  }

  // --- Summary ---
  console.log("\n  Summary:");

  for (const r of results) {
    console.log(`    ${label(r.status)} ${r.name}`);
  }

  if (fixing && fixCount > 0) {
    console.log(`\n  Auto-fixed ${fixCount} issue${fixCount === 1 ? "" : "s"}`);
  }

  const fails = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "WARN").length;

  if (fails > 0) {
    console.log(`\n  Result: ${fails} failed, ${warns} warnings — run 'skynet init' to fix.\n`);
    process.exit(1);
  } else if (warns > 0) {
    console.log(`\n  Result: All checks passed with ${warns} warning(s).\n`);
  } else {
    console.log("\n  Result: All checks passed.\n");
  }
}
