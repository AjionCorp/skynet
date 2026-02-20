import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../utils/loadConfig";

interface PauseOptions {
  dir?: string;
}

export async function pauseCommand(options: PauseOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const pauseFile = join(devDir, "pipeline-paused");

  // Idempotent: if already paused, show info and return
  if (existsSync(pauseFile)) {
    try {
      const existing = JSON.parse(readFileSync(pauseFile, "utf-8"));
      console.log(`\n  Pipeline is already paused.`);
      console.log(`    Paused at: ${existing.pausedAt}`);
      console.log(`    Paused by: ${existing.pausedBy}`);
      console.log(`\n  Run 'skynet resume' to unpause.\n`);
    } catch {
      console.log(`\n  Pipeline is already paused (sentinel exists).\n`);
    }
    return;
  }

  const sentinel = {
    pausedAt: new Date().toISOString(),
    pausedBy: process.env.USER || process.env.USERNAME || "user",
  };

  // Atomic write: write to tmp file then rename
  const tmpFile = `${pauseFile}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(sentinel, null, 2) + "\n");
  renameSync(tmpFile, pauseFile);

  console.log(`\n  Pipeline paused.`);
  console.log(`    Workers will exit at their next checkpoint.`);
  console.log(`    Watchdog will skip new worker dispatch but continue health checks.`);
  console.log(`\n  Run 'skynet resume' to unpause.\n`);
}
