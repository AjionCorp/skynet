import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => ""),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

vi.mock("readline", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_q: string, cb: (a: string) => void) => cb("n")),
    close: vi.fn(),
  })),
}));

vi.mock("../../utils/sqliteQuery", () => ({
  isSqliteReady: vi.fn(() => true),
  sqliteQuery: vi.fn(() => ""),
  sqliteRows: vi.fn(() => []),
  sqlEscape: vi.fn((s: string) => s.replace(/'/g, "''")),
}));

import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { isSqliteReady, sqliteQuery, sqliteRows, sqlEscape as _sqlEscape } from "../../utils/sqliteQuery";
import { resetTaskCommand } from "../reset-task";

const mockExistsSync = vi.mocked(existsSync);
const mockSpawnSync = vi.mocked(spawnSync);
const mockIsSqliteReady = vi.mocked(isSqliteReady);
const mockSqliteQuery = vi.mocked(sqliteQuery);
const mockSqliteRows = vi.mocked(sqliteRows);

const CONFIG_CONTENT = [
  'export SKYNET_PROJECT_NAME="test-project"',
  'export SKYNET_PROJECT_DIR="/tmp/test-project"',
  'export SKYNET_DEV_DIR="/tmp/test-project/.dev"',
].join("\n");

// Mock readFileSync at module level for loadConfig
import { readFileSync } from "fs";
const mockReadFileSync = vi.mocked(readFileSync);

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
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      return "" as never;
    });

    mockIsSqliteReady.mockReturnValue(true);

    // Default: single matching task
    mockSqliteRows.mockReturnValue([
      ["42", "[FEAT] Add user auth", "dev/add-user-auth", "typecheck", "3", "failed"],
    ]);

    // By default branch does not exist (spawnSync show-ref returns non-zero)
    mockSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" } as never);
  });

  it("fuzzy-matches task title substring in failed-tasks SQLite table", async () => {
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

    // Should call sqliteQuery to reset the task
    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test-project/.dev",
      expect.stringContaining("UPDATE tasks SET status='pending'"),
    );
    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test-project/.dev",
      expect.stringContaining("attempts=0"),
    );

    // Should log the reset
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("attempts");
    expect(logCalls).toContain("pending");
  });

  it("updates task status in SQLite", async () => {
    await resetTaskCommand("user auth", { dir: "/tmp/test-project" });

    // Should have called sqliteQuery for the UPDATE
    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test-project/.dev",
      expect.stringContaining("WHERE id=42"),
    );
  });

  it("deletes stale branch with --force flag", async () => {
    // Branch exists
    mockSpawnSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      const argsStr = argsArr ? argsArr.join(" ") : "";
      if (argsStr.includes("show-ref"))
        return { status: 0, stdout: "", stderr: "" } as never;
      if (argsStr.includes("branch") && argsStr.includes("-D"))
        return { status: 0, stdout: "", stderr: "" } as never;
      return { status: 0, stdout: "", stderr: "" } as never;
    });

    await resetTaskCommand("user auth", { dir: "/tmp/test-project", force: true });

    // Should have called git branch -D
    const deleteCalls = mockSpawnSync.mock.calls.filter((c) => {
      const argsArr = c[1] as string[];
      return argsArr && argsArr.includes("-D");
    });
    expect(deleteCalls).toHaveLength(1);
    expect((deleteCalls[0][1] as string[]).join(" ")).toContain("dev/add-user-auth");

    // Should log deletion
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Branch deleted");
  });

  it("errors when no matching task is found", async () => {
    mockSqliteRows.mockReturnValue([]);

    await expect(
      resetTaskCommand("nonexistent task", { dir: "/tmp/test-project" }),
    ).rejects.toThrow("process.exit");

    const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(errorCalls).toContain("No matching");
  });

  it("errors when multiple tasks match", async () => {
    mockSqliteRows.mockReturnValue([
      ["42", "[FEAT] Add feature one", "dev/add-feature-one", "typecheck", "3", "failed"],
      ["43", "[FEAT] Add feature two", "dev/add-feature-two", "lint", "1", "failed"],
    ]);

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
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("skynet.config.sh not found"),
    );
  });
});
