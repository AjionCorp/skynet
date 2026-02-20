import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
}));

vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "", error: null, signal: null })),
}));

import { readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { testNotifyCommand } from "../test-notify";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockSpawnSync = vi.mocked(spawnSync);

/** Build a config file with given overrides. */
function makeConfigContent(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    SKYNET_PROJECT_NAME: "test-project",
    SKYNET_PROJECT_DIR: "/tmp/test-project",
    SKYNET_DEV_DIR: "/tmp/test-project/.dev",
    SKYNET_NOTIFY_CHANNELS: "telegram,slack",
    SKYNET_TG_ENABLED: "true",
    SKYNET_TG_BOT_TOKEN: "123:ABC",
    SKYNET_TG_CHAT_ID: "-100123",
    SKYNET_SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
  };
  const vars = { ...defaults, ...overrides };
  return Object.entries(vars)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join("\n");
}

describe("testNotifyCommand", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("reads SKYNET_NOTIFY_CHANNELS from config and identifies enabled channels", async () => {
    const configContent = makeConfigContent({
      SKYNET_NOTIFY_CHANNELS: "telegram,slack,discord",
      SKYNET_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(configContent as never);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: null,
      signal: null,
    } as never);

    await testNotifyCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");

    // All three channels should be tested
    expect(logCalls).toContain("telegram: OK");
    expect(logCalls).toContain("slack: OK");
    expect(logCalls).toContain("discord: OK");
  });

  it("executes correct scripts/notify/<channel>.sh for each enabled channel", async () => {
    const configContent = makeConfigContent({
      SKYNET_NOTIFY_CHANNELS: "telegram,slack",
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(configContent as never);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: null,
      signal: null,
    } as never);

    await testNotifyCommand({ dir: "/tmp/test-project" });

    // spawnSync should be called for each channel with bash -c and source the correct script
    const spawnCalls = mockSpawnSync.mock.calls;
    expect(spawnCalls.length).toBe(2);

    // Both calls should invoke bash
    expect(spawnCalls[0][0]).toBe("bash");
    expect(spawnCalls[1][0]).toBe("bash");

    // The script argument should reference the correct notify scripts
    const script1 = (spawnCalls[0][1] as string[])[1];
    const script2 = (spawnCalls[1][1] as string[])[1];
    expect(script1).toContain("notify/telegram.sh");
    expect(script2).toContain("notify/slack.sh");
  });

  it("--channel flag tests only the specified channel", async () => {
    const configContent = makeConfigContent({
      SKYNET_NOTIFY_CHANNELS: "telegram,slack",
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(configContent as never);
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: null,
      signal: null,
    } as never);

    await testNotifyCommand({ dir: "/tmp/test-project", channel: "telegram" });

    // Only one spawnSync call for telegram
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    const script = (mockSpawnSync.mock.calls[0][1] as string[])[1];
    expect(script).toContain("notify/telegram.sh");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("telegram: OK");
    expect(logCalls).not.toContain("slack");
  });

  it("reports per-channel OK/FAILED with captured output", async () => {
    const configContent = makeConfigContent({
      SKYNET_NOTIFY_CHANNELS: "telegram,slack",
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(configContent as never);

    // Telegram succeeds, slack fails with connection refused (curl exit 7)
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: "sent",
        stderr: "",
        error: null,
        signal: null,
      } as never)
      .mockReturnValueOnce({
        status: 7,
        stdout: "",
        stderr: "connection refused",
        error: null,
        signal: null,
      } as never);

    await expect(testNotifyCommand({ dir: "/tmp/test-project" })).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("telegram: OK");
    expect(logCalls).toContain("slack: FAILED");
    expect(logCalls).toContain("connection refused");
  });

  it("handles no configured channels with helpful message", async () => {
    const configContent = makeConfigContent({
      SKYNET_NOTIFY_CHANNELS: "",
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(configContent as never);

    await testNotifyCommand({ dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("No notification channels configured");
    expect(logCalls).toContain("SKYNET_NOTIFY_CHANNELS");

    // Should not attempt to spawn any scripts
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("handles script execution failure gracefully with FAILED status", async () => {
    const configContent = makeConfigContent({
      SKYNET_NOTIFY_CHANNELS: "telegram",
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(configContent as never);

    // Simulate a non-zero exit (e.g. curl timeout, exit code 28)
    mockSpawnSync.mockReturnValue({
      status: 28,
      stdout: "",
      stderr: "timeout",
      error: null,
      signal: null,
    } as never);

    await expect(testNotifyCommand({ dir: "/tmp/test-project" })).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("telegram: FAILED");
    expect(logCalls).toContain("timeout");

    // process.exit(1) should be called for failures
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
