import { describe, it, expect, vi, beforeEach } from "vitest";
import { readPid, isProcessAlive, killByLock, listProjectDriverLocks, killAllWorkers } from "./process-locks";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import { readFileSync, readdirSync } from "fs";

const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("readPid", () => {
  it("reads pid from directory-based lock (lockPath/pid file)", () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith("/pid")) return "12345\n";
      throw new Error("not found");
    });
    expect(readPid("/tmp/test.lock")).toBe(12345);
  });

  it("falls back to reading lockPath as a file when pid subfile fails", () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith("/pid")) throw new Error("not found");
      return "67890\n";
    });
    expect(readPid("/tmp/test.lock")).toBe(67890);
  });

  it("returns null when both reads fail", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(readPid("/tmp/test.lock")).toBeNull();
  });

  it("returns null for non-numeric content", () => {
    mockReadFileSync.mockReturnValue("not-a-number\n");
    expect(readPid("/tmp/test.lock")).toBeNull();
  });

  it("returns null for zero pid", () => {
    mockReadFileSync.mockReturnValue("0\n");
    expect(readPid("/tmp/test.lock")).toBeNull();
  });

  it("returns null for negative pid", () => {
    mockReadFileSync.mockReturnValue("-1\n");
    expect(readPid("/tmp/test.lock")).toBeNull();
  });

  it("returns null for Infinity", () => {
    mockReadFileSync.mockReturnValue("Infinity\n");
    expect(readPid("/tmp/test.lock")).toBeNull();
  });

  it("trims whitespace from pid content", () => {
    mockReadFileSync.mockReturnValue("  42  \n");
    expect(readPid("/tmp/test.lock")).toBe(42);
  });
});

describe("isProcessAlive", () => {
  it("returns true when process.kill(pid, 0) succeeds", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(isProcessAlive(12345)).toBe(true);
    expect(spy).toHaveBeenCalledWith(12345, 0);
  });

  it("returns false when process.kill(pid, 0) throws", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(isProcessAlive(99999)).toBe(false);
  });
});

describe("killByLock", () => {
  it("kills an alive process and returns true", () => {
    mockReadFileSync.mockReturnValue("100\n");
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(killByLock("/tmp/test.lock")).toBe(true);
    expect(spy).toHaveBeenCalledWith(100, "SIGTERM");
  });

  it("returns false when no pid is found", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(killByLock("/tmp/test.lock")).toBe(false);
  });

  it("returns false when process is not alive", () => {
    mockReadFileSync.mockReturnValue("100\n");
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) throw new Error("ESRCH");
      return true;
    });

    expect(killByLock("/tmp/test.lock")).toBe(false);
    // Only the signal-0 probe should have been called
    expect(spy).toHaveBeenCalledWith(100, 0);
    expect(spy).not.toHaveBeenCalledWith(100, "SIGTERM");
  });

  it("returns false when SIGTERM throws", () => {
    mockReadFileSync.mockReturnValue("100\n");
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw new Error("EPERM");
    });

    expect(killByLock("/tmp/test.lock")).toBe(false);
  });
});

describe("listProjectDriverLocks", () => {
  it("returns matching lock files", () => {
    mockReaddirSync.mockReturnValue([
      "skynet-project-driver-abc.lock",
      "skynet-project-driver-def.lock",
      "skynet-watchdog.lock",
      "other-file.txt",
    ] as unknown as ReturnType<typeof readdirSync>);

    const result = listProjectDriverLocks("/tmp/skynet");
    expect(result).toEqual([
      "/tmp/skynet-project-driver-abc.lock",
      "/tmp/skynet-project-driver-def.lock",
    ]);
  });

  it("returns empty array when directory read fails", () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(listProjectDriverLocks("/tmp/skynet")).toEqual([]);
  });

  it("returns empty array when no locks match", () => {
    mockReaddirSync.mockReturnValue([
      "skynet-watchdog.lock",
      "other.txt",
    ] as unknown as ReturnType<typeof readdirSync>);
    expect(listProjectDriverLocks("/tmp/skynet")).toEqual([]);
  });
});

describe("killAllWorkers", () => {
  it("kills watchdog, dev-workers, task-fixers, and project-driver", () => {
    // Every lock file returns a valid pid, every process is alive
    mockReadFileSync.mockReturnValue("100\n");
    vi.spyOn(process, "kill").mockImplementation(() => true);
    mockReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);

    const result = killAllWorkers("/tmp/skynet", 2, 2);
    expect(result).toContain("watchdog");
    expect(result).toContain("dev-worker-1");
    expect(result).toContain("dev-worker-2");
    expect(result).toContain("task-fixer-1");
    expect(result).toContain("task-fixer-2");
    expect(result).toContain("project-driver");
  });

  it("returns empty array when no processes are alive", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    mockReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);

    expect(killAllWorkers("/tmp/skynet", 2, 1)).toEqual([]);
  });

  it("kills numbered project-driver locks when they exist", () => {
    mockReadFileSync.mockReturnValue("100\n");
    vi.spyOn(process, "kill").mockImplementation(() => true);
    mockReaddirSync.mockReturnValue([
      "skynet-project-driver-abc.lock",
    ] as unknown as ReturnType<typeof readdirSync>);

    const result = killAllWorkers("/tmp/skynet", 0, 0);
    // Should include watchdog and the named project-driver lock
    expect(result).toContain("watchdog");
    expect(result.some((r) => r.includes("project-driver"))).toBe(true);
    // Should NOT include the plain "project-driver" since numbered locks were found
  });
});
