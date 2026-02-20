import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => ""),
}));

vi.mock("os", () => ({
  platform: vi.fn(() => "darwin"),
}));

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { platform } from "os";
import { setupAgentsCommand } from "../setup-agents";

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockExistsSync = vi.mocked(existsSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockExecSync = vi.mocked(execSync);
const mockPlatform = vi.mocked(platform);

const CONFIG_CONTENT = [
  'export SKYNET_PROJECT_NAME="test-project"',
  'export SKYNET_PROJECT_DIR="/tmp/test-project"',
  'export SKYNET_DEV_DIR="/tmp/test-project/.dev"',
].join("\n");

const SAMPLE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.skynet.SKYNET_PROJECT_NAME.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>SKYNET_SCRIPTS_DIR/watchdog.sh</string>
  </array>
</dict>
</plist>`;

describe("setupAgentsCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockPlatform.mockReturnValue("darwin");

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      // Templates directory and LaunchAgents directory
      if (path.includes("launchagents") || path.includes("LaunchAgents")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith(".plist")) return SAMPLE_PLIST as never;
      return "" as never;
    });

    mockReaddirSync.mockImplementation((p) => {
      const path = String(p);
      if (path.includes("launchagents")) {
        return [
          "com.skynet.PROJECT.watchdog.plist",
          "com.skynet.PROJECT.health-check.plist",
        ] as never;
      }
      return [] as never;
    });

    mockExecSync.mockImplementation(() => "" as never);
  });

  it("generates launchd plist files on darwin", async () => {
    mockPlatform.mockReturnValue("darwin");

    await setupAgentsCommand({ dir: "/tmp/test-project" });

    // Should write plist files
    expect(mockWriteFileSync).toHaveBeenCalled();

    // Check that plist content has placeholders replaced
    const writeCall = mockWriteFileSync.mock.calls[0];
    const writtenContent = String(writeCall[1]);
    expect(writtenContent).toContain("test-project");
    expect(writtenContent).not.toContain("SKYNET_PROJECT_NAME");

    // Should call launchctl load
    const loadCalls = mockExecSync.mock.calls.filter((c) =>
      String(c[0]).includes("launchctl load"),
    );
    expect(loadCalls.length).toBeGreaterThan(0);

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("LaunchAgents");
  });

  it("generates crontab entries on linux", async () => {
    mockPlatform.mockReturnValue("linux");

    // crontab -l returns empty (no existing crontab)
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("crontab -l")) throw new Error("no crontab") as never;
      return "" as never;
    });

    await setupAgentsCommand({ dir: "/tmp/test-project" });

    // Should install crontab via `crontab -`
    const crontabCalls = mockExecSync.mock.calls.filter((c) => {
      const cmdStr = String(c[0]);
      return cmdStr === "crontab -";
    });
    expect(crontabCalls).toHaveLength(1);

    // Verify input contains skynet markers and schedule entries
    const installCall = crontabCalls[0];
    const input = String((installCall[1] as { input?: string })?.input || "");
    expect(input).toContain("# BEGIN skynet:test-project");
    expect(input).toContain("# END skynet:test-project");
    expect(input).toContain("watchdog");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("crontab");
  });

  it("removes agents with --uninstall on darwin (launchd)", async () => {
    mockPlatform.mockReturnValue("darwin");

    // LaunchAgents dir has skynet plist files
    mockReaddirSync.mockImplementation((p) => {
      const path = String(p);
      if (path.includes("LaunchAgents")) {
        return [
          "com.skynet.test-project.watchdog.plist",
          "com.skynet.test-project.health-check.plist",
        ] as never;
      }
      return [] as never;
    });

    await setupAgentsCommand({ uninstall: true });

    // Should call launchctl unload for each plist
    const unloadCalls = mockExecSync.mock.calls.filter((c) =>
      String(c[0]).includes("launchctl unload"),
    );
    expect(unloadCalls).toHaveLength(2);

    // Should delete plist files
    expect(mockUnlinkSync).toHaveBeenCalledTimes(2);

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Removed 2 agent");
  });

  it("removes agents with --uninstall on linux (cron)", async () => {
    mockPlatform.mockReturnValue("linux");

    const existingCrontab = [
      "0 * * * * /usr/bin/something",
      "# BEGIN skynet:test-project",
      "# Watchdog (every 3 min)",
      "*/3 * * * * SKYNET_DEV_DIR=/tmp/.dev /bin/bash /tmp/scripts/watchdog.sh >> /tmp/.dev/scripts/watchdog.log 2>&1",
      "# END skynet:test-project",
      "",
    ].join("\n");

    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("crontab -l")) return existingCrontab as never;
      return "" as never;
    });

    await setupAgentsCommand({ uninstall: true, cron: true });

    // Should reinstall cleaned crontab
    const crontabCalls = mockExecSync.mock.calls.filter((c) => {
      const cmdStr = String(c[0]);
      return cmdStr === "crontab -";
    });
    expect(crontabCalls).toHaveLength(1);

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Removed");
  });

  it("shows what would be installed with --dry-run on darwin", async () => {
    mockPlatform.mockReturnValue("darwin");

    await setupAgentsCommand({ dir: "/tmp/test-project", dryRun: true });

    // Should NOT actually write plist files
    expect(mockWriteFileSync).not.toHaveBeenCalled();

    // Should NOT call launchctl load
    const loadCalls = mockExecSync.mock.calls.filter((c) =>
      String(c[0]).includes("launchctl load"),
    );
    expect(loadCalls).toHaveLength(0);

    // Should show dry-run output
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("dry-run");
    expect(logCalls).toContain("Would write");
  });

  it("shows what would be installed with --dry-run on linux (cron)", async () => {
    mockPlatform.mockReturnValue("linux");

    await setupAgentsCommand({ dir: "/tmp/test-project", dryRun: true, cron: true });

    // Should NOT install crontab
    const crontabInstallCalls = mockExecSync.mock.calls.filter((c) => {
      const cmdStr = String(c[0]);
      return cmdStr === "crontab -";
    });
    expect(crontabInstallCalls).toHaveLength(0);

    // Should show dry-run output with cron entries
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("dry-run");
    expect(logCalls).toContain("crontab");
  });

  it("throws when config file is missing", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return false;
      return false;
    });

    await expect(
      setupAgentsCommand({ dir: "/tmp/test-project" }),
    ).rejects.toThrow("skynet.config.sh not found");
  });
});
