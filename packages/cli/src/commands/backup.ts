import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { resolve, join } from "path";
import { spawnSync } from "child_process";
import { loadConfig } from "../utils/loadConfig.js";

interface BackupOptions {
  dir?: string;
}

export async function backupCommand(options: BackupOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const dbPath = join(devDir, "skynet.db");

  if (!existsSync(dbPath)) {
    console.error("skynet.db not found. Pipeline has not been initialized.");
    process.exit(1);
  }

  const backupDir = join(devDir, "db-backups");
  mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[T:]/g, "-").slice(0, 19);
  const backupFile = join(backupDir, `skynet.db.${timestamp}`);

  try {
    const result = spawnSync("sqlite3", [dbPath], {
      input: `.backup '${backupFile.replace(/'/g, "''")}'`,
      encoding: "utf-8",
      timeout: 30000,
    });
    if (result.status !== 0) {
      const stderr = result.stderr ? result.stderr.trim() : "";
      throw new Error(`sqlite3 backup failed (exit ${result.status}): ${stderr}`);
    }

    const size = statSync(backupFile).size;
    const sizeKb = Math.round(size / 1024);
    console.log(`\n  Backup created: ${backupFile}`);
    console.log(`  Size: ${sizeKb} KB\n`);

    // Rotate: keep 7 most recent
    const files = readdirSync(backupDir)
      .filter((f) => f.startsWith("skynet.db."))
      .sort()
      .reverse();

    if (files.length > 7) {
      for (const old of files.slice(7)) {
        unlinkSync(join(backupDir, old));
      }
      console.log(`  Rotated: removed ${files.length - 7} old backup(s)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Backup failed: ${msg}`);
    process.exit(1);
  }
}
