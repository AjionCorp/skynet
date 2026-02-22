import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

/**
 * Run a SQLite query against the skynet.db database using the sqlite3 CLI.
 * Uses spawnSync with array args to avoid shell metacharacter injection.
 * Returns raw stdout string. Throws on missing DB or query error.
 */
export function sqliteQuery(devDir: string, sql: string): string {
  const dbPath = join(devDir, "skynet.db");
  if (!existsSync(dbPath)) {
    throw new Error("skynet.db not found");
  }
  const result = spawnSync("sqlite3", ["-separator", "|", dbPath, sql], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`sqlite3 query failed (exit ${result.status}): ${stderr}`);
  }
  return (result.stdout || "").trim();
}

/**
 * Run a SQLite query and return rows as arrays of strings (pipe-delimited).
 */
export function sqliteRows(devDir: string, sql: string): string[][] {
  const raw = sqliteQuery(devDir, sql);
  if (!raw) return [];
  return raw.split("\n").map((line) => line.split("|"));
}

/**
 * Run a SQLite query and return a single scalar value.
 */
export function sqliteScalar(devDir: string, sql: string): string {
  return sqliteQuery(devDir, sql).split("\n")[0] || "";
}

/**
 * Check if the skynet.db exists and has the tasks table initialized.
 */
export function isSqliteReady(devDir: string): boolean {
  try {
    const count = sqliteScalar(devDir, "SELECT COUNT(*) FROM tasks;");
    return count !== "";
  } catch {
    return false;
  }
}

/**
 * Escape a string for safe use in SQL single-quoted literals.
 */
export function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}
