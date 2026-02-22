import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../utils/loadConfig";
import { sqliteQuery, isSqliteReady } from "../utils/sqliteQuery";

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

export async function exportCommand(options: ExportOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }
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

  // Include SQLite DB dump if available
  if (isSqliteReady(devDir)) {
    try {
      snapshot["skynet.db.dump"] = sqliteQuery(devDir, ".dump");
    } catch {
      // DB dump failed — skip
    }
  }

  const isoDate = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultPath = `skynet-snapshot-${isoDate}.json`;
  const outputPath = resolve(options.output || defaultPath);

  writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), "utf-8");

  console.log(`\n  Pipeline snapshot exported to: ${outputPath}`);
  console.log(`  Files included: ${STATE_FILES.length}`);

  const allKeys = Object.keys(snapshot);
  const included = allKeys.filter((f) => snapshot[f] !== "");
  const missing = allKeys.filter((f) => snapshot[f] === "");

  if (included.length > 0) {
    console.log(`  Present: ${included.join(", ")}`);
  }
  if (missing.length > 0) {
    console.log(`  Missing/empty: ${missing.join(", ")}`);
  }

  console.log("");
}
