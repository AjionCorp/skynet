import { readdirSync, readFileSync } from "fs";
import { basename, dirname, resolve } from "path";

export function readPid(lockPath: string): number | null {
  try {
    let content: string;
    try {
      content = readFileSync(resolve(lockPath, "pid"), "utf-8").trim();
    } catch {
      content = readFileSync(lockPath, "utf-8").trim();
    }
    const pid = Number(content);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killByLock(lockPath: string): boolean {
  const pid = readPid(lockPath);
  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function listProjectDriverLocks(lockPrefix: string): string[] {
  try {
    const dir = dirname(lockPrefix);
    const base = `${basename(lockPrefix)}-project-driver-`;
    return readdirSync(dir)
      .filter((name) => name.startsWith(base) && name.endsWith(".lock"))
      .map((name) => resolve(dir, name));
  } catch {
    return [];
  }
}

/** Kill all workers (watchdog, dev-workers, task-fixers, project-driver). Returns names of killed processes. */
export function killAllWorkers(lockPrefix: string, maxWorkers: number, maxFixers: number): string[] {
  const killed: string[] = [];
  if (killByLock(`${lockPrefix}-watchdog.lock`)) killed.push("watchdog");
  for (let i = 1; i <= maxWorkers; i++) {
    if (killByLock(`${lockPrefix}-dev-worker-${i}.lock`)) killed.push(`dev-worker-${i}`);
  }
  if (killByLock(`${lockPrefix}-task-fixer.lock`)) killed.push("task-fixer-1");
  for (let i = 2; i <= maxFixers; i++) {
    if (killByLock(`${lockPrefix}-task-fixer-${i}.lock`)) killed.push(`task-fixer-${i}`);
  }
  const pdLocks = listProjectDriverLocks(lockPrefix);
  if (pdLocks.length === 0) {
    if (
      killByLock(`${lockPrefix}-project-driver-global.lock`) ||
      killByLock(`${lockPrefix}-project-driver.lock`)
    ) {
      killed.push("project-driver");
    }
  } else {
    for (const lockPath of pdLocks) {
      if (killByLock(lockPath)) {
        const name = lockPath.split("/").pop() || "project-driver";
        killed.push(name.replace(`${basename(lockPrefix)}-`, "").replace(/\.lock$/, ""));
      }
    }
  }
  return killed;
}
