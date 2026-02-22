import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { resolve, join, normalize } from "path";
import { createInterface } from "readline";
import { loadConfig } from "../utils/loadConfig";

interface ImportOptions {
  dir?: string;
  dryRun?: boolean;
  merge?: boolean;
  force?: boolean;
}

const EXPECTED_KEYS = [
  "backlog.md",
  "completed.md",
  "failed-tasks.md",
  "blockers.md",
  "mission.md",
  "skynet.config.sh",
];

const MD_FILES = new Set([
  "backlog.md",
  "completed.md",
  "failed-tasks.md",
  "blockers.md",
  "mission.md",
]);

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

export async function importCommand(snapshotPath: string, options: ImportOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;

  // Read and parse snapshot
  const resolvedPath = resolve(snapshotPath);
  if (!existsSync(resolvedPath)) {
    console.error(`Error: Snapshot file not found: ${resolvedPath}`);
    process.exit(1);
  }

  let snapshot: Record<string, string>;
  try {
    const raw = readFileSync(resolvedPath, "utf-8");
    snapshot = JSON.parse(raw);
  } catch {
    console.error(`Error: Failed to parse snapshot file as JSON.`);
    process.exit(1);
  }

  // Validate expected keys
  const missingKeys = EXPECTED_KEYS.filter((key) => !(key in snapshot));
  if (missingKeys.length > 0) {
    console.error(`Error: Snapshot is missing expected keys: ${missingKeys.join(", ")}`);
    process.exit(1);
  }

  // Build file plan
  const snapshotKeys = Object.keys(snapshot);
  const plan: Array<{
    filename: string;
    targetPath: string;
    currentSize: number;
    newSize: number;
    action: "overwrite" | "create" | "merge";
  }> = [];

  for (const filename of snapshotKeys) {
    // Reject path traversal attempts
    const resolved = resolve(devDir, filename);
    if (!resolved.startsWith(resolve(devDir) + "/") && resolved !== resolve(devDir)) {
      console.error(`  Skipping unsafe filename: ${filename}`);
      continue;
    }
    const targetPath = resolved;
    const exists = existsSync(targetPath);
    const currentSize = exists ? statSync(targetPath).size : 0;
    const isMd = MD_FILES.has(filename);
    const action = !exists ? "create" : options.merge && isMd ? "merge" : "overwrite";
    const newContent = snapshot[filename];

    let finalSize: number;
    if (action === "merge" && exists) {
      const existing = readFileSync(targetPath, "utf-8");
      finalSize = Buffer.byteLength(existing + "\n" + newContent, "utf-8");
    } else {
      finalSize = Buffer.byteLength(newContent, "utf-8");
    }

    plan.push({ filename, targetPath, currentSize, newSize: finalSize, action });
  }

  // Display plan
  console.log(`\n  Snapshot: ${resolvedPath}`);
  console.log(`  Target:   ${devDir}`);
  console.log(`  Files:    ${plan.length}\n`);

  for (const entry of plan) {
    const sizeChange =
      entry.currentSize === 0
        ? `(${entry.newSize} bytes)`
        : `(${entry.currentSize} -> ${entry.newSize} bytes)`;
    const label =
      entry.action === "create"
        ? "[create]"
        : entry.action === "merge"
          ? "[merge] "
          : "[write] ";
    console.log(`  ${label} ${entry.filename} ${sizeChange}`);
  }
  console.log("");

  // Dry-run: stop here
  if (options.dryRun) {
    console.log("  Dry run — no files were modified.\n");
    return;
  }

  // Confirm unless --force
  if (!options.force) {
    const ok = await confirm("  Overwrite .dev/ state files? (y/N) ");
    if (!ok) {
      console.log("\n  Import cancelled.\n");
      return;
    }
    console.log("");
  }

  // Write files
  let written = 0;
  for (const entry of plan) {
    const content = snapshot[entry.filename];

    if (entry.action === "merge") {
      const existing = readFileSync(entry.targetPath, "utf-8");
      writeFileSync(entry.targetPath, existing + "\n" + content, "utf-8");
    } else {
      writeFileSync(entry.targetPath, content, "utf-8");
    }
    written++;
  }

  console.log(`  Imported ${written} files into ${devDir}\n`);
}
