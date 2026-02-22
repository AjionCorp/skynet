import { readFileSync, statSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

/**
 * Check if a worker is running by inspecting its lock file and verifying the PID.
 * Supports both dir-based locks (lockFile/pid) and legacy file-based locks.
 */
export function getWorkerStatus(lockFile: string): {
  running: boolean;
  pid: number | null;
  ageMs: number | null;
} {
  try {
    let pid: string;
    try {
      pid = readFileSync(join(lockFile, "pid"), "utf-8").trim();
    } catch {
      pid = readFileSync(lockFile, "utf-8").trim();
    }
    if (!/^\d+$/.test(pid)) return { running: false, pid: null, ageMs: null };
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    const age = Date.now() - statSync(lockFile).mtimeMs;
    return { running: true, pid: Number(pid), ageMs: age };
  } catch {
    return { running: false, pid: null, ageMs: null };
  }
}
