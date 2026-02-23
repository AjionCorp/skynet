import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

vi.mock("../../utils/loadConfig", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../utils/sqliteQuery", () => ({
  isSqliteReady: vi.fn(() => false),
  sqliteRows: vi.fn(() => []),
  sqliteQuery: vi.fn(() => ""),
  sqlEscape: vi.fn((s: string) => s.replace(/'/g, "''")),
}));

import { existsSync } from "fs";
import { execSync } from "child_process";
import { loadConfig } from "../../utils/loadConfig";
import { isSqliteReady, sqliteRows, sqliteQuery } from "../../utils/sqliteQuery";
import { recoverGitCommand } from "../recover-git";

const mockExistsSync = vi.mocked(existsSync);
const mockExecSync = vi.mocked(execSync);
const mockLoadConfig = vi.mocked(loadConfig);
const mockIsSqliteReady = vi.mocked(isSqliteReady);
const mockSqliteRows = vi.mocked(sqliteRows);
const mockSqliteQuery = vi.mocked(sqliteQuery);

describe("recoverGitCommand", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("detects divergence with rev-list count", async () => {
    mockLoadConfig.mockReturnValue({
      SKYNET_DEV_DIR: "/tmp/test/.dev",
      SKYNET_MAIN_BRANCH: "main",
    });
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git fetch")) return Buffer.from("") as never;
      if (cmdStr.includes("rev-list --count")) return "3" as never;
      if (cmdStr.includes("git log --oneline"))
        return "abc1234 chore: update pipeline status after [FEAT] Add feature\ndef5678 feat: add feature\nghi9012 chore: update pipeline status after [FIX] Fix bug" as never;
      return "" as never;
    });

    // dry-run mode so it doesn't try to reset
    await expect(
      recoverGitCommand({ dir: "/tmp/test", dryRun: true })
    ).rejects.toThrow("process.exit");

    // Should have called rev-list to check divergence
    const revListCalls = mockExecSync.mock.calls.filter(([cmd]) =>
      String(cmd).includes("rev-list --count")
    );
    expect(revListCalls.length).toBe(1);

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("3");
    expect(logCalls).toContain("Divergence");
  });

  it("dry-run mode shows changes without acting", async () => {
    mockLoadConfig.mockReturnValue({
      SKYNET_DEV_DIR: "/tmp/test/.dev",
      SKYNET_MAIN_BRANCH: "main",
    });
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git fetch")) return Buffer.from("") as never;
      if (cmdStr.includes("rev-list --count")) return "2" as never;
      if (cmdStr.includes("git log --oneline"))
        return "abc1234 chore: update pipeline status after [FEAT] Add widget\ndef5678 feat: add widget" as never;
      return "" as never;
    });

    await expect(
      recoverGitCommand({ dir: "/tmp/test", dryRun: true })
    ).rejects.toThrow("process.exit");

    // Dry run should exit with 0
    expect(exitSpy).toHaveBeenCalledWith(0);

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("DRY RUN");
    expect(logCalls).toContain("no changes made");

    // Should NOT have called git reset
    const resetCalls = mockExecSync.mock.calls.filter(([cmd]) =>
      String(cmd).includes("git reset")
    );
    expect(resetCalls.length).toBe(0);
  });

  it("resets diverged tasks to failed in SQLite", async () => {
    mockLoadConfig.mockReturnValue({
      SKYNET_DEV_DIR: "/tmp/test/.dev",
      SKYNET_MAIN_BRANCH: "main",
    });
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("git fetch")) return Buffer.from("") as never;
      if (cmdStr.includes("rev-list --count")) return "1" as never;
      if (cmdStr.includes("git log --oneline"))
        return "abc1234 chore: update pipeline status after [FEAT] Add dashboard" as never;
      if (cmdStr.includes("git reset --hard")) return Buffer.from("") as never;
      return "" as never;
    });
    mockIsSqliteReady.mockReturnValue(true);
    mockSqliteRows.mockReturnValue([["42", "completed"]]);

    await recoverGitCommand({ dir: "/tmp/test", force: true });

    // Should have called sqliteQuery to reset the task
    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test/.dev",
      expect.stringContaining("UPDATE tasks SET status='failed'")
    );

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Reset task 42");
    expect(logCalls).toContain("Recovery complete");
  });
});
