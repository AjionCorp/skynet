import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => ""),
}));

vi.mock("readline", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_q: string, cb: (a: string) => void) => cb("n")),
    close: vi.fn(),
  })),
}));

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resetTaskCommand } from "../reset-task";

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockExistsSync = vi.mocked(existsSync);
const mockExecSync = vi.mocked(execSync);

const CONFIG_CONTENT = [
  'export SKYNET_PROJECT_NAME="test-project"',
  'export SKYNET_PROJECT_DIR="/tmp/test-project"',
  'export SKYNET_DEV_DIR="/tmp/test-project/.dev"',
].join("\n");

const SAMPLE_FAILED_TASKS = `| Date | Task | Branch | Error | Attempts | Status |
|------|------|--------|-------|----------|--------|
| 2026-02-20 | [FEAT] Add user auth | dev/add-user-auth | typecheck | 3 | failed |
| 2026-02-19 | [FIX] Fix login bug | dev/fix-login-bug | lint | 1 | pending |`;

const SAMPLE_BACKLOG = `# Backlog

- [x] [FEAT] Add user auth — implement user authentication
- [ ] [FEAT] Add dashboard — create admin dashboard
- [x] [FIX] Fix login bug — fix the login page bug`;

describe("resetTaskCommand", () => {
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
      if (path.endsWith("failed-tasks.md")) return true;
      if (path.endsWith("backlog.md")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("failed-tasks.md")) return SAMPLE_FAILED_TASKS as never;
      if (path.endsWith("backlog.md")) return SAMPLE_BACKLOG as never;
      return "" as never;
    });

    // By default branch does not exist (git show-ref throws)
    mockExecSync.mockImplementation(() => {
      throw new Error("not a valid ref");
    });
  });

  it("fuzzy-matches task title substring in failed-tasks.md", async () => {
    await resetTaskCommand("user auth", { dir: "/tmp/test-project" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");

    // Should find and display the matching task
    expect(logCalls).toContain("[FEAT] Add user auth");
    expect(logCalls).toContain("dev/add-user-auth");
    expect(logCalls).toContain("typecheck");
  });

  it("resets status to pending and attempts to 0", async () => {
    await resetTaskCommand("user auth", { dir: "/tmp/test-project" });

    // Should write updated failed-tasks.md (via atomic write pattern)
    expect(mockWriteFileSync).toHaveBeenCalled();

    // Find the failed-tasks.md write (first atomic write)
    const failedWriteCall = mockWriteFileSync.mock.calls[0];
    const writtenContent = String(failedWriteCall[1]);

    // The reset line should have attempts=0 and status=pending
    expect(writtenContent).toContain("| 0 | pending |");

    // Should log the reset
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("attempts");
    expect(logCalls).toContain("pending");
  });

  it("updates backlog.md entry from [x] to [ ]", async () => {
    await resetTaskCommand("user auth", { dir: "/tmp/test-project" });

    // Should have two atomic writes: failed-tasks.md and backlog.md
    // Each atomic write = writeFileSync + renameSync
    expect(mockRenameSync).toHaveBeenCalledTimes(2);

    // Find the backlog.md write (second atomic write)
    const backlogWriteCall = mockWriteFileSync.mock.calls[1];
    const writtenContent = String(backlogWriteCall[1]);

    // The matching entry should be unchecked
    expect(writtenContent).toContain("- [ ] [FEAT] Add user auth");
    // Other entries should remain unchanged
    expect(writtenContent).toContain("- [ ] [FEAT] Add dashboard");
    expect(writtenContent).toContain("- [x] [FIX] Fix login bug");

    // Should log the backlog reset
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("[x]");
    expect(logCalls).toContain("[ ]");
  });

  it("deletes stale branch with --force flag", async () => {
    // Branch exists
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes("show-ref")) return "" as never;
      if (cmdStr.includes("branch -D")) return "" as never;
      return "" as never;
    });

    await resetTaskCommand("user auth", { dir: "/tmp/test-project", force: true });

    // Should have called git branch -D
    const deleteCalls = mockExecSync.mock.calls.filter((c) =>
      String(c[0]).includes("branch -D"),
    );
    expect(deleteCalls).toHaveLength(1);
    expect(String(deleteCalls[0][0])).toContain("dev/add-user-auth");

    // Should log deletion
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Branch deleted");
  });

  it("errors when no matching task is found", async () => {
    await expect(
      resetTaskCommand("nonexistent task", { dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(errorCalls).toContain("No matching task found");
  });

  it("errors when multiple tasks match", async () => {
    // Both tasks contain "fix" or a shared substring — use broader match
    const multiMatchFailed = `| Date | Task | Branch | Error | Attempts | Status |
|------|------|--------|-------|----------|--------|
| 2026-02-20 | [FEAT] Add feature one | dev/add-feature-one | typecheck | 3 | failed |
| 2026-02-19 | [FEAT] Add feature two | dev/add-feature-two | lint | 1 | pending |`;

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("failed-tasks.md")) return multiMatchFailed as never;
      if (path.endsWith("backlog.md")) return SAMPLE_BACKLOG as never;
      return "" as never;
    });

    await expect(
      resetTaskCommand("Add feature", { dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(errorCalls).toContain("Multiple tasks match");
  });

  it("errors when title substring is empty", async () => {
    await expect(
      resetTaskCommand("", { dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(errorCalls).toContain("Task title substring is required");
  });

  it("throws when config file is missing", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return false;
      return false;
    });

    await expect(
      resetTaskCommand("user auth", { dir: "/tmp/test-project" }),
    ).rejects.toThrow("skynet.config.sh not found");
  });
});
