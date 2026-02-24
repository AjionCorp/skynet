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
  const result = spawnSync("sqlite3", ["-cmd", ".timeout 5000", "-separator", "\x1f", dbPath, sql], {
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
 * Run a SQLite query and return rows as arrays of strings.
 * Uses ASCII Unit Separator (0x1F) to avoid field corruption from pipes in data.
 */
export function sqliteRows(devDir: string, sql: string): string[][] {
  const raw = sqliteQuery(devDir, sql);
  if (!raw) return [];
  return raw.split("\n").map((line) => line.split("\x1f"));
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
 * Escape a string for safe embedding in SQL single-quoted literals
 * passed to the sqlite3 CLI. This is the CLI's SQL injection defense.
 *
 * Security model: Removes NUL bytes, escapes backslashes, replaces
 * newlines (preventing dot-command injection), and doubles single quotes.
 *
 * IMPORTANT: This function is ONLY safe when the escaped value is
 * embedded inside SQL single-quoted string literals. It does NOT
 * protect against injection in other SQL contexts (e.g., table names,
 * column names, or unquoted numeric positions).
 */
export function sqlEscape(value: string): string {
  return value
    .replace(/\0/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .replace(/'/g, "''");
}

/**
 * Sanitize a value for use as a SQL integer. Returns 0 for non-numeric values.
 * Prevents NaN injection into SQL queries when numeric values come from config.
 */
export function sqlInt(value: string | number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 0;
  return n;
}
