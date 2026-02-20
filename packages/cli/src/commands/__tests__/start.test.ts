import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

import { readFileSync, existsSync, readdirSync } from "fs";
import { execSync, spawn } from "child_process";
import { startCommand } from "../start";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockExecSync = vi.mocked(execSync);
const mockSpawn = vi.mocked(spawn);

const CONFIG_CONTENT = [
  'export SKYNET_PROJECT_NAME="test-project"',
  'export SKYNET_DEV_DIR="/tmp/test-project/.dev"',
  'export SKYNET_LOCK_PREFIX="/tmp/skynet-test-project"',
].join("\n");

describe("startCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("watchdog.sh")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      return "" as never;
    });

    // No launchd agents dir by default
    mockReaddirSync.mockReturnValue([] as never);
  });

  it("launches watchdog.sh via spawn when no launchd agents", async () => {
    const mockChild = { unref: vi.fn(), pid: 12345 };
    mockSpawn.mockReturnValue(mockChild as never);

    await startCommand({ dir: "/tmp/test-project" });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("bash");
    expect(args).toEqual([expect.stringContaining("watchdog.sh")]);
    expect(opts).toEqual(
      expect.objectContaining({
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      }),
    );
    expect(mockChild.unref).toHaveBeenCalled();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Watchdog launched");
    expect(logCalls).toContain("12345");
  });

  it("detects already-running watchdog via PID lock file", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("watchdog.sh")) return true;
      if (path.endsWith("-watchdog.lock")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("-watchdog.lock")) return "99999" as never;
      return "" as never;
    });

    // kill -0 succeeds (process is running)
    mockExecSync.mockReturnValue("" as never);

    await startCommand({ dir: "/tmp/test-project" });

    expect(mockSpawn).not.toHaveBeenCalled();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("already running");
  });

  it("spawns watchdog when lock exists but process is not running", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("watchdog.sh")) return true;
      if (path.endsWith("-watchdog.lock")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("-watchdog.lock")) return "99999" as never;
      return "" as never;
    });

    // kill -0 fails (process not running)
    mockExecSync.mockImplementation(() => {
      throw new Error("No such process");
    });

    const mockChild = { unref: vi.fn(), pid: 54321 };
    mockSpawn.mockReturnValue(mockChild as never);

    await startCommand({ dir: "/tmp/test-project" });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("exits when watchdog.sh is missing", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      // watchdog.sh does NOT exist
      return false;
    });

    await expect(
      startCommand({ dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("watchdog.sh not found"),
    );
  });

  it("exits when SKYNET_PROJECT_NAME is not set", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh"))
        return 'export SKYNET_DEV_DIR="/tmp/test/.dev"' as never;
      return "" as never;
    });

    await expect(
      startCommand({ dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SKYNET_PROJECT_NAME not set"),
    );
  });

  it("loads launchd agents when plist files exist", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("LaunchAgents")) return true;
      return false;
    });

    mockReaddirSync.mockReturnValue([
      "com.skynet.test-project.watchdog.plist",
      "com.skynet.test-project.worker-1.plist",
    ] as never);

    mockExecSync.mockReturnValue("" as never);

    await startCommand({ dir: "/tmp/test-project" });

    // Should have called launchctl load for each plist
    const launchctlCalls = mockExecSync.mock.calls.filter((c) =>
      String(c[0]).includes("launchctl load"),
    );
    expect(launchctlCalls).toHaveLength(2);

    // Should NOT have spawned watchdog.sh directly
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
