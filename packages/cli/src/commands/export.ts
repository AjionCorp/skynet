import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";

interface ExportOptions {
  dir?: string;
  output?: string;
}

const STATE_FILES = [
  "backlog.md",
  "completed.md",
  "failed-tasks.md",
  "blockers.md",
  "mission.md",
  "skynet.config.sh",
  "events.log",
];

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

export async function exportCommand(options: ExportOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;

  const snapshot: Record<string, string> = {};

  for (const filename of STATE_FILES) {
    const filePath = join(devDir, filename);
    try {
      snapshot[filename] = readFileSync(filePath, "utf-8");
    } catch {
      snapshot[filename] = "";
    }
  }

  const isoDate = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultPath = `skynet-snapshot-${isoDate}.json`;
  const outputPath = resolve(options.output || defaultPath);

  writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), "utf-8");

  console.log(`\n  Pipeline snapshot exported to: ${outputPath}`);
  console.log(`  Files included: ${STATE_FILES.length}`);

  const included = STATE_FILES.filter((f) => snapshot[f] !== "");
  const missing = STATE_FILES.filter((f) => snapshot[f] === "");

  if (included.length > 0) {
    console.log(`  Present: ${included.join(", ")}`);
  }
  if (missing.length > 0) {
    console.log(`  Missing/empty: ${missing.join(", ")}`);
  }

  console.log("");
}
