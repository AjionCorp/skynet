import { readFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";
import { loadConfig } from "../utils/loadConfig";

interface StopOptions {
  dir?: string;
}

function stopProcess(lockFile: string, name: string): boolean {
  if (!existsSync(lockFile)) {
    return false;
  }

  const pid = readFileSync(lockFile, "utf-8").trim();

  // Validate PID is numeric to prevent injection
  if (!/^\d+$/.test(pid)) {
    console.log(`    Warning: Invalid PID in ${lockFile}, removing stale lock.`);
    unlinkSync(lockFile);
    return false;
  }

  try {
    // Check if process is actually running
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });

    // Send SIGTERM for graceful shutdown
    process.kill(Number(pid), "SIGTERM");
    console.log(`    Stopped: ${name} (PID ${pid})`);
    unlinkSync(lockFile);
    return true;
  } catch {
    // Process not running — clean up stale lock
    console.log(`    Cleaned: ${name} (stale lock, PID ${pid})`);
    unlinkSync(lockFile);
    return false;
  }
}

export async function stopCommand(options: StopOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const projectName = vars.SKYNET_PROJECT_NAME;
  const lockPrefix = vars.SKYNET_LOCK_PREFIX || `/tmp/skynet-${projectName}`;

  if (!projectName) {
    console.error("Error: SKYNET_PROJECT_NAME not set in config.");
    process.exit(1);
  }

  console.log(`\n  Stopping Skynet pipeline for: ${projectName}\n`);

  // Step 1: Unload launchd agents if installed
  const launchAgentsDir = join(process.env.HOME || "~", "Library/LaunchAgents");
  let agentsUnloaded = 0;

  if (existsSync(launchAgentsDir)) {
    const plists = readdirSync(launchAgentsDir).filter(
      (f) => f.startsWith(`com.skynet.${projectName}.`) && f.endsWith(".plist")
    );

    if (plists.length > 0) {
      console.log("  Unloading launchd agents...\n");

      for (const plist of plists) {
        const plistPath = join(launchAgentsDir, plist);
        try {
          execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
          agentsUnloaded++;
          console.log(`    Unloaded: ${plist}`);
        } catch {
          console.log(`    Skipped: ${plist} (not loaded)`);
        }
      }

      console.log(`\n  ${agentsUnloaded}/${plists.length} agents unloaded.\n`);
    }
  }

  // Step 2: Kill running workers via PID lock files
  const workers = [
    "dev-worker-1", "dev-worker-2", "task-fixer", "project-driver",
    "sync-runner", "ui-tester", "feature-validator", "health-check",
    "auth-refresh", "watchdog",
  ];

  let stopped = 0;
  let cleaned = 0;

  console.log("  Stopping workers...\n");

  for (const worker of workers) {
    const lockFile = `${lockPrefix}-${worker}.lock`;
    if (existsSync(lockFile)) {
      if (stopProcess(lockFile, worker)) {
        stopped++;
      } else {
        cleaned++;
      }
    }
  }

  if (stopped === 0 && cleaned === 0) {
    console.log("    No running workers found.");
  } else {
    console.log(`\n  ${stopped} workers stopped, ${cleaned} stale locks cleaned.`);
  }

  console.log(`\n  Pipeline stopped. Run 'skynet start' to resume.\n`);
}
