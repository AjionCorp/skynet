import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { resolve, join } from "path";

interface PauseOptions {
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

export async function pauseCommand(options: PauseOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);

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
