import { readFileSync, statSync } from "fs";
import { execSync } from "child_process";

/**
 * Check if a worker is running by inspecting its lock file and verifying the PID.
 */
export function getWorkerStatus(lockFile: string): {
  running: boolean;
  pid: number | null;
  ageMs: number | null;
} {
  try {
    const pid = readFileSync(lockFile, "utf-8").trim();
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    const age = Date.now() - statSync(lockFile).mtimeMs;
    return { running: true, pid: Number(pid), ageMs: age };
  } catch {
    return { running: false, pid: null, ageMs: null };
  }
}
