import { readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

export function isProcessRunning(lockPath: string): { running: boolean; pid: string } {
  try {
    // Support dir-based locks (lockPath/pid) and legacy file-based locks
    let pid: string;
    try {
      pid = readFileSync(join(lockPath, "pid"), "utf-8").trim();
    } catch {
      pid = readFileSync(lockPath, "utf-8").trim();
    }
    // Validate PID is numeric to prevent shell injection
    if (!/^\d+$/.test(pid)) return { running: false, pid: "" };
    execSync(`kill -0 ${pid}`, { stdio: "ignore" });
    return { running: true, pid };
  } catch {
    return { running: false, pid: "" };
  }
}
