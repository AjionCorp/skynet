import { readFileSync } from "fs";
import { join } from "path";

export function isProcessRunning(lockPath: string): { running: boolean; pid: string } {
  try {
    // Support dir-based locks (lockPath/pid) and legacy file-based locks
    let pid: string;
    try {
      pid = readFileSync(join(lockPath, "pid"), "utf-8").trim();
    } catch {
      pid = readFileSync(lockPath, "utf-8").trim();
    }
    if (!/^\d+$/.test(pid)) return { running: false, pid: "" };
    process.kill(Number(pid), 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid: "" };
  }
}
