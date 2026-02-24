import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

vi.mock("../../utils/isProcessRunning", () => ({
  isProcessRunning: vi.fn(() => ({ running: false, pid: "" })),
}));

import { readFileSync, existsSync, readdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { stopCommand } from "../stop";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockRmSync = vi.mocked(rmSync);
const mockSpawnSync = vi.mocked(spawnSync);

const CONFIG_CONTENT = [
  'export SKYNET_PROJECT_NAME="test-project"',
  'export SKYNET_DEV_DIR="/tmp/test-project/.dev"',
  'export SKYNET_LOCK_PREFIX="/tmp/skynet-test-project"',
].join("\n");

describe("stopCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Spy on process.kill to prevent actually killing processes
    vi.spyOn(process, "kill").mockImplementation(() => true);

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      return "" as never;
    });

    mockReaddirSync.mockReturnValue([] as never);
  });

  it("sends SIGTERM to running workers", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("-dev-worker-1.lock")) return true;
      if (path.endsWith("-watchdog.lock")) return true;
      return false;
    });

    // readFileSync: for lock files, return PID string.
    // The stop command first tries to read lockFile/pid (dir-based lock)
    // then falls back to reading lockFile directly (legacy file-based lock).
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      // Dir-based lock: reading lockFile/pid will fail (ENOENT)
      // so we make it throw, then the fallback reads the lock file directly
      if (path.includes("/pid")) throw new Error("ENOENT") as never;
      if (path.endsWith("-dev-worker-1.lock")) return "11111" as never;
      if (path.endsWith("-watchdog.lock")) return "22222" as never;
      return "" as never;
    });

    // process.kill with signal 0 should succeed (processes are running),
    // then SIGTERM should succeed
    vi.mocked(process.kill).mockImplementation(() => true);

    await stopCommand({ dir: "/tmp/test-project" });

    // Should have sent SIGTERM to both processes
    expect(process.kill).toHaveBeenCalledWith(11111, "SIGTERM");
    expect(process.kill).toHaveBeenCalledWith(22222, "SIGTERM");

    // Should have cleaned up lock files via rmSync
    const rmCalls = mockRmSync.mock.calls.map((c) => String(c[0]));
    expect(rmCalls.some((p) => p.includes("-dev-worker-1.lock"))).toBe(true);
    expect(rmCalls.some((p) => p.includes("-watchdog.lock"))).toBe(true);

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Stopped");
    expect(logCalls).toContain("2 workers stopped");
  });

  it("handles missing PID files gracefully", async () => {
    // No lock files exist (default mock)
    await stopCommand({ dir: "/tmp/test-project" });

    // process.kill should only have been called via the mock spy setup,
    // not for actual process termination
    const killCalls = vi.mocked(process.kill).mock.calls.filter(
      (c) => c[1] === "SIGTERM" || c[1] === 0
    );
    expect(killCalls).toHaveLength(0);
    expect(mockRmSync).not.toHaveBeenCalled();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("No running workers found");
  });

  it("cleans stale lock files when process is not running", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("-task-fixer-1.lock")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.includes("/pid")) throw new Error("ENOENT") as never;
      if (path.endsWith("-task-fixer-1.lock")) return "33333" as never;
      return "" as never;
    });

    // process.kill(pid, 0) throws — process not running
    vi.mocked(process.kill).mockImplementation(() => {
      throw new Error("No such process");
    });

    await stopCommand({ dir: "/tmp/test-project" });

    // Should clean up the stale lock via rmSync
    const rmCalls = mockRmSync.mock.calls.map((c) => String(c[0]));
    expect(rmCalls.some((p) => p.includes("-task-fixer-1.lock"))).toBe(true);

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Cleaned");
    expect(logCalls).toContain("stale lock");
  });

  it("removes lock with invalid (non-numeric) PID", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("-dev-worker-2.lock")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.includes("/pid")) throw new Error("ENOENT") as never;
      if (path.endsWith("-dev-worker-2.lock")) return "not-a-pid" as never;
      return "" as never;
    });

    await stopCommand({ dir: "/tmp/test-project" });

    // Invalid PID should still clean up the lock file via rmSync
    const rmCalls = mockRmSync.mock.calls.map((c) => String(c[0]));
    expect(rmCalls.some((p) => p.includes("-dev-worker-2.lock"))).toBe(true);

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Invalid PID");
  });

  it("reads PID from dir-based lock (lockFile/pid) and kills the process", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("-dev-worker-1.lock")) return true;
      return false;
    });

    // Dir-based lock: readFileSync(join(lockFile, "pid")) succeeds
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      // Return a valid PID when reading the dir-based lock's pid file
      if (path.includes("-dev-worker-1.lock/pid")) return "44444" as never;
      return "" as never;
    });

    // process.kill succeeds (process is running)
    vi.mocked(process.kill).mockImplementation(() => true);

    await stopCommand({ dir: "/tmp/test-project" });

    // Should read PID from dir-based lock path and send SIGTERM
    expect(process.kill).toHaveBeenCalledWith(44444, 0);
    expect(process.kill).toHaveBeenCalledWith(44444, "SIGTERM");

    // Should clean up the lock dir
    const rmCalls = mockRmSync.mock.calls.map((c) => String(c[0]));
    expect(rmCalls.some((p) => p.includes("-dev-worker-1.lock"))).toBe(true);

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Stopped");
    expect(logCalls).toContain("44444");
  });

  it("exits when SKYNET_PROJECT_NAME is not set", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh"))
        return 'export SKYNET_DEV_DIR="/tmp/test/.dev"' as never;
      return "" as never;
    });

    await expect(
      stopCommand({ dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SKYNET_PROJECT_NAME not set"),
    );
  });

  it("unloads launchd agents when plist files exist", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("LaunchAgents")) return true;
      return false;
    });

    mockReaddirSync.mockReturnValue([
      "com.skynet.test-project.watchdog.plist",
    ] as never);

    // spawnSync for launchctl unload
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);

    await stopCommand({ dir: "/tmp/test-project" });

    const unloadCalls = mockSpawnSync.mock.calls.filter((c) => {
      const argsArr = c[1] as string[];
      return c[0] === "launchctl" && argsArr && argsArr[0] === "unload";
    });
    expect(unloadCalls).toHaveLength(1);
  });
});
