import { readFileSync, unlinkSync, existsSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../utils/loadConfig";

interface ResumeOptions {
  dir?: string;
}

export async function resumeCommand(options: ResumeOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const pauseFile = join(devDir, "pipeline-paused");

  if (!existsSync(pauseFile)) {
    console.log(`\n  Pipeline is not paused.\n`);
    return;
  }

  // Show what we're resuming from
  try {
    const existing = JSON.parse(readFileSync(pauseFile, "utf-8"));
    console.log(`\n  Resuming pipeline.`);
    console.log(`    Was paused at: ${existing.pausedAt}`);
    console.log(`    Was paused by: ${existing.pausedBy}`);
  } catch {
    console.log(`\n  Resuming pipeline.`);
  }

  unlinkSync(pauseFile);

  console.log(`\n  Pipeline resumed. Workers will pick up tasks on next dispatch.\n`);
}
