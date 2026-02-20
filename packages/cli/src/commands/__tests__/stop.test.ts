import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { readFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { stopCommand } from "../stop";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockExecSync = vi.mocked(execSync);

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

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("-dev-worker-1.lock")) return "11111" as never;
      if (path.endsWith("-watchdog.lock")) return "22222" as never;
      return "" as never;
    });

    // kill -0 succeeds (processes are running)
    mockExecSync.mockReturnValue("" as never);

    await stopCommand({ dir: "/tmp/test-project" });

    // Should have sent SIGTERM to both processes
    expect(process.kill).toHaveBeenCalledWith(11111, "SIGTERM");
    expect(process.kill).toHaveBeenCalledWith(22222, "SIGTERM");

    // Should have cleaned up lock files
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("-dev-worker-1.lock"),
    );
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("-watchdog.lock"),
    );

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Stopped");
    expect(logCalls).toContain("2 workers stopped");
  });

  it("handles missing PID files gracefully", async () => {
    // No lock files exist (default mock)
    await stopCommand({ dir: "/tmp/test-project" });

    expect(process.kill).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("No running workers found");
  });

  it("cleans stale lock files when process is not running", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("-task-fixer.lock")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("-task-fixer.lock")) return "33333" as never;
      return "" as never;
    });

    // kill -0 fails (process not running)
    mockExecSync.mockImplementation(() => {
      throw new Error("No such process");
    });

    await stopCommand({ dir: "/tmp/test-project" });

    // Should clean up the stale lock
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("-task-fixer.lock"),
    );

    // Should NOT have called process.kill (process wasn't running)
    expect(process.kill).not.toHaveBeenCalled();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Cleaned");
    expect(logCalls).toContain("stale lock");
    expect(logCalls).toContain("1 stale locks cleaned");
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
      if (path.endsWith("-dev-worker-2.lock")) return "not-a-pid" as never;
      return "" as never;
    });

    await stopCommand({ dir: "/tmp/test-project" });

    // Invalid PID should still clean up the lock file
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("-dev-worker-2.lock"),
    );

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Invalid PID");
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

    mockExecSync.mockReturnValue("" as never);

    await stopCommand({ dir: "/tmp/test-project" });

    const unloadCalls = mockExecSync.mock.calls.filter((c) =>
      String(c[0]).includes("launchctl unload"),
    );
    expect(unloadCalls).toHaveLength(1);
  });
});
