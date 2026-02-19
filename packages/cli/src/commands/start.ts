import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { execSync, spawn } from "child_process";

interface StartOptions {
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

function isProcessRunning(lockFile: string): boolean {
  try {
    const pid = readFileSync(lockFile, "utf-8").trim();
    // Validate PID is numeric to prevent shell injection
    if (!/^\d+$/.test(pid)) return false;
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function startCommand(options: StartOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);

  const projectName = vars.SKYNET_PROJECT_NAME;
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const scriptsDir = `${devDir}/scripts`;
  const lockPrefix = vars.SKYNET_LOCK_PREFIX || `/tmp/skynet-${projectName}`;

  if (!projectName) {
    console.error("Error: SKYNET_PROJECT_NAME not set in config.");
    process.exit(1);
  }

  console.log(`\n  Starting Skynet pipeline for: ${projectName}\n`);

  // Strategy 1: Try loading launchd agents if they are installed
  const launchAgentsDir = join(process.env.HOME || "~", "Library/LaunchAgents");
  const agentsLoaded: string[] = [];

  if (existsSync(launchAgentsDir)) {
    const plists = readdirSync(launchAgentsDir).filter(
      (f) => f.startsWith(`com.skynet.${projectName}.`) && f.endsWith(".plist")
    );

    if (plists.length > 0) {
      console.log("  Loading launchd agents...\n");

      for (const plist of plists) {
        const plistPath = join(launchAgentsDir, plist);
        try {
          execSync(`launchctl load "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
          agentsLoaded.push(plist);
          console.log(`    Loaded: ${plist}`);
        } catch {
          // Already loaded or failed — check if already running
          console.log(`    Skipped: ${plist} (already loaded or failed)`);
        }
      }

      console.log(`\n  ${agentsLoaded.length}/${plists.length} agents loaded.`);
    }
  }

  // Strategy 2: If no launchd agents found, launch watchdog.sh directly as background process
  if (agentsLoaded.length === 0) {
    const watchdogScript = join(scriptsDir, "watchdog.sh");
    const watchdogLock = `${lockPrefix}-watchdog.lock`;

    if (!existsSync(watchdogScript)) {
      console.error("  Error: watchdog.sh not found. Run 'skynet init' and 'skynet setup-agents' first.");
      process.exit(1);
    }

    if (existsSync(watchdogLock) && isProcessRunning(watchdogLock)) {
      console.log("  Watchdog is already running.");
    } else {
      console.log("  No launchd agents found. Launching watchdog.sh directly...\n");

      const logFile = join(scriptsDir, "watchdog.log");
      const child = spawn("bash", [watchdogScript], {
        cwd: projectDir,
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, SKYNET_DEV_DIR: devDir },
      });

      child.unref();
      console.log(`    Watchdog launched (PID: ${child.pid})`);
      console.log(`    Log: ${logFile}`);
    }
  }

  console.log(`\n  Run 'skynet status' to check pipeline health.\n`);
}
