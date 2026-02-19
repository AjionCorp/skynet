import { readFileSync, unlinkSync, existsSync } from "fs";
import { resolve, join } from "path";

interface ResumeOptions {
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

export async function resumeCommand(options: ResumeOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);

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
