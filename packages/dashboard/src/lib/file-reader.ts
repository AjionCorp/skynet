import { readFileSync, realpathSync, statSync, openSync, readSync, closeSync } from "fs";
import { resolve } from "path";

/**
 * Read a file from the .dev/ directory. Returns empty string if file does not exist.
 * Rejects path traversal attempts (../ sequences, absolute paths, symlinks escaping devDir).
 */
export function readDevFile(devDir: string, filename: string): string {
  if (/\.\.[/\\]/.test(filename) || filename.startsWith("/")) return "";
  const resolved = resolve(devDir, filename);
  const resolvedDevDir = resolve(devDir);
  if (!resolved.startsWith(resolvedDevDir + "/") && resolved !== resolvedDevDir) return "";
  // Cache canonical devDir outside try to avoid TOCTOU between realpathSync calls.
  // NOTE: A narrow TOCTOU window exists between the realpathSync checks and the
  // readFileSync below — a symlink could be swapped between validation and read.
  // This is acceptable because .dev/ is operator-owned and not writable by
  // untrusted users. The symlink check is defense-in-depth, not a security boundary.
  let canonicalDevDir: string;
  try {
    canonicalDevDir = realpathSync(resolvedDevDir);
  } catch {
    return "";
  }
  try {
    // Resolve symlinks to prevent escaping devDir via symlink targets
    const real = realpathSync(resolved);
    if (!real.startsWith(canonicalDevDir)) return "";
    return readFileSync(real, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Read the last line of a script log file. Returns null if the log does not exist.
 * Uses a pure Node.js implementation that reads the last ~4KB of the file
 * instead of spawning a `tail` subprocess.
 */
export function getLastLogLine(
  devDir: string,
  script: string
): string | null {
  if (!/^[a-z0-9-]+$/i.test(script)) return null;
  const logPath = resolve(devDir, "scripts", `${script}.log`);
  try {
    const stat = statSync(logPath);
    const fd = openSync(logPath, "r");
    try {
      const readSize = Math.min(stat.size, 4096);
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      const text = buf.toString("utf-8");
      const lines = text.split("\n").filter(Boolean);
      return lines.length > 0 ? lines[lines.length - 1] : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Extract a timestamp from a log line in [YYYY-MM-DD HH:MM:SS] format.
 */
export function extractTimestamp(logLine: string | null): string | null {
  if (!logLine) return null;
  const match = logLine.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
  return match?.[1] ?? null;
}
