import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock("../../utils/sqliteQuery", () => ({
  isSqliteReady: vi.fn(() => true),
  sqliteQuery: vi.fn(() => ""),
  sqlEscape: vi.fn((s: string) => s.replace(/'/g, "''")),
}));

import { readFileSync, existsSync } from "fs";
import { isSqliteReady, sqliteQuery, sqlEscape as _sqlEscape } from "../../utils/sqliteQuery";
import { addTaskCommand } from "../add-task";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockIsSqliteReady = vi.mocked(isSqliteReady);
const mockSqliteQuery = vi.mocked(sqliteQuery);

const CONFIG_CONTENT = 'export SKYNET_PROJECT_NAME="test-project"\nexport SKYNET_PROJECT_DIR="/tmp/test"\nexport SKYNET_DEV_DIR="/tmp/test/.dev"';

describe("addTaskCommand", () => {
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
  });

  it("inserts task with correct format via SQLite", async () => {
    await addTaskCommand("Add user auth", {
      dir: "/tmp/test",
      tag: "FEAT",
      description: "OAuth2 login flow",
      position: "top",
    });

    // Should call sqliteQuery to INSERT the task
    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test/.dev",
      expect.stringContaining("INSERT INTO tasks"),
    );
    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test/.dev",
      expect.stringContaining("Add user auth"),
    );
    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test/.dev",
      expect.stringContaining("FEAT"),
    );

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("[FEAT] Add user auth");
    expect(logCalls).toContain("OAuth2 login flow");
  });

  it("uses default tag FEAT when none specified", async () => {
    await addTaskCommand("New feature", { dir: "/tmp/test" });

    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test/.dev",
      expect.stringContaining("FEAT"),
    );

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("[FEAT] New feature");
  });

  it("uppercases the tag", async () => {
    await addTaskCommand("Fix bug", { dir: "/tmp/test", tag: "fix" });

    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test/.dev",
      expect.stringContaining("FIX"),
    );

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("[FIX] Fix bug");
  });

  it("position=top bumps priority of existing tasks", async () => {
    await addTaskCommand("Urgent task", {
      dir: "/tmp/test",
      position: "top",
    });

    // Should bump existing task priorities
    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test/.dev",
      expect.stringContaining("UPDATE tasks SET priority=priority+1"),
    );

    // Should insert with priority 0 (top)
    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test/.dev",
      expect.stringContaining("0, '"),
    );
  });

  it("position=bottom uses high priority number", async () => {
    await addTaskCommand("Bottom task", {
      dir: "/tmp/test",
      position: "bottom",
    });

    // Should NOT bump existing task priorities
    const updateCalls = mockSqliteQuery.mock.calls.filter(([, sql]) =>
      sql.includes("UPDATE tasks SET priority"),
    );
    expect(updateCalls).toHaveLength(0);

    // Should insert with priority 999 (bottom)
    expect(mockSqliteQuery).toHaveBeenCalledWith(
      "/tmp/test/.dev",
      expect.stringContaining("999"),
    );
  });

  it("inserts task via sqliteQuery", async () => {
    await addTaskCommand("Safe write task", { dir: "/tmp/test" });

    // Should have called sqliteQuery for INSERT
    const insertCalls = mockSqliteQuery.mock.calls.filter(([, sql]) =>
      sql.includes("INSERT INTO tasks"),
    );
    expect(insertCalls).toHaveLength(1);
  });

  it("rejects empty title", async () => {
    await expect(
      addTaskCommand("", { dir: "/tmp/test" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Task title is required"),
    );
  });

  it("rejects invalid position", async () => {
    await expect(
      addTaskCommand("Some task", { dir: "/tmp/test", position: "middle" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("--position must be 'top' or 'bottom'"),
    );
  });
});
