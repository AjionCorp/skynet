import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { resolve, join, basename } from "path";
import { spawnSync } from "child_process";
import { loadConfig } from "../utils/loadConfig.js";
import { isProcessRunning } from "../utils/isProcessRunning.js";

interface RestoreOptions {
  dir?: string;
  force?: boolean;
}

export async function restoreDbCommand(file: string, options: RestoreOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }

  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const dbPath = join(devDir, "skynet.db");
  const restorePath = resolve(file);

  if (!existsSync(restorePath)) {
    console.error(`Backup file not found: ${restorePath}`);
    process.exit(1);
  }

  // Validate the backup file is a valid SQLite database
  try {
    const checkResult = spawnSync("sqlite3", [restorePath, "PRAGMA integrity_check;"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    if (checkResult.status !== 0) {
      const stderr = (checkResult.stderr || "").trim();
      throw new Error(`sqlite3 integrity check failed (exit ${checkResult.status}): ${stderr}`);
    }
    const check = (checkResult.stdout || "").trim();
    if (check !== "ok") {
      console.error(`Backup file failed integrity check: ${check}`);
      process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cannot validate backup file: ${msg}`);
    process.exit(1);
  }

  // Check for running pipeline processes
  const lockPrefix = vars.SKYNET_LOCK_PREFIX || `/tmp/skynet-${vars.SKYNET_PROJECT_NAME}`;
  const maxWorkers = Number(vars.SKYNET_MAX_WORKERS) || 4;
  let runningWorkers = 0;
  for (let i = 1; i <= maxWorkers; i++) {
    const lockFile = `${lockPrefix}-dev-worker-${i}.lock`;
    const { running } = isProcessRunning(lockFile);
    if (running) runningWorkers++;
  }
  if (runningWorkers > 0 && !options.force) {
    console.error(`${runningWorkers} worker(s) appear to be running. Use --force to restore anyway.`);
    process.exit(1);
  }

  const restoreSize = statSync(restorePath).size;
  const restoreKb = Math.round(restoreSize / 1024);
  console.log(`\n  Restoring from: ${basename(restorePath)} (${restoreKb} KB)`);

  // Back up current DB before replacing
  if (existsSync(dbPath)) {
    const backupDir = join(devDir, "db-backups");
    mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[T:]/g, "-").slice(0, 19);
    const preRestoreBackup = join(backupDir, `skynet.db.pre-restore-${timestamp}`);
    try {
      // preRestoreBackup is generated from ISO timestamp + devDir — no user input.
      // The single-quote escaping is defense-in-depth for the .backup command.
      const backupResult = spawnSync("sqlite3", [dbPath, `.backup '${preRestoreBackup.replace(/'/g, "''")}'`], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      });
      if (backupResult.status !== 0) {
        throw new Error(`sqlite3 backup failed (exit ${backupResult.status})`);
      }
      console.log(`  Pre-restore backup: ${basename(preRestoreBackup)}`);
    } catch {
      // If current DB is corrupted, just copy it
      copyFileSync(dbPath, preRestoreBackup);
      console.log(`  Pre-restore copy: ${basename(preRestoreBackup)} (raw copy — DB may be corrupted)`);
    }
  }

  // Replace the database
  try {
    copyFileSync(restorePath, dbPath);
    // Verify the restored DB
    const verifyResult = spawnSync("sqlite3", [dbPath, "PRAGMA integrity_check;"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    if (verifyResult.status !== 0) {
      const stderr = (verifyResult.stderr || "").trim();
      throw new Error(`sqlite3 integrity check failed (exit ${verifyResult.status}): ${stderr}`);
    }
    const verify = (verifyResult.stdout || "").trim();
    if (verify === "ok") {
      console.log("  Restore: OK (integrity verified)");
    } else {
      console.log(`  Restore: WARNING (integrity check returned: ${verify})`);
    }

    const countResult = spawnSync("sqlite3", [dbPath, "SELECT COUNT(*) FROM tasks;"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    if (countResult.status !== 0) {
      throw new Error(`sqlite3 count query failed (exit ${countResult.status})`);
    }
    const taskCount = (countResult.stdout || "").trim();
    console.log(`  Tasks in restored DB: ${taskCount}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Restore failed: ${msg}`);
    process.exit(1);
  }
}
