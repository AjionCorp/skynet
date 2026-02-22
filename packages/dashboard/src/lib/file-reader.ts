import { readFileSync, realpathSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";

/**
 * Read a file from the .dev/ directory. Returns empty string if file does not exist.
 * Rejects path traversal attempts (../ sequences, absolute paths, symlinks escaping devDir).
 */
export function readDevFile(devDir: string, filename: string): string {
  if (/\.\.[/\\]/.test(filename) || filename.startsWith("/")) return "";
  const resolved = resolve(devDir, filename);
  if (!resolved.startsWith(resolve(devDir))) return "";
  try {
    // Resolve symlinks to prevent escaping devDir via symlink targets
    const real = realpathSync(resolved);
    if (!real.startsWith(realpathSync(devDir))) return "";
    return readFileSync(real, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Read the last line of a script log file. Returns null if the log does not exist.
 */
export function getLastLogLine(
  devDir: string,
  script: string
): string | null {
  if (!/^[a-z0-9-]+$/i.test(script)) return null;
  try {
    const result = spawnSync("tail", ["-1", `${devDir}/scripts/${script}.log`], {
      encoding: "utf-8",
      timeout: 2000,
    });
    const line = (result.stdout || "").trim();
    return line || null;
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
