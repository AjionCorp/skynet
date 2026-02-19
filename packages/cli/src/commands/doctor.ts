import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";

interface DoctorOptions {
  dir?: string;
}

function loadConfig(projectDir: string): Record<string, string> | null {
  const configPath = join(projectDir, ".dev/skynet.config.sh");
  if (!existsSync(configPath)) {
    return null;
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
    const pid = readFileSync(lockFile, "utf-8").trim();
    if (!/^\d+$/.test(pid)) return { running: false, pid: "" };
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    return { running: true, pid };
  } catch {
    return { running: false, pid: "" };
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

  console.log(`\n  Skynet Doctor — ${projectDir}\n`);

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

  // --- Summary ---
  console.log("\n  Summary:");

  for (const r of results) {
    console.log(`    ${label(r.status)} ${r.name}`);
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
