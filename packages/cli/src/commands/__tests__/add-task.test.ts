import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { addTaskCommand } from "../add-task";

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockExistsSync = vi.mocked(existsSync);

const CONFIG_CONTENT = 'export SKYNET_PROJECT_NAME="test-project"\nexport SKYNET_PROJECT_DIR="/tmp/test"\nexport SKYNET_DEV_DIR="/tmp/test/.dev"';

const SAMPLE_BACKLOG = `# Backlog

- [ ] [FEAT] Existing pending task — some description
- [ ] [FIX] Another pending task
- [x] [FEAT] Completed task — already done
`;

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
      if (path.endsWith("backlog.md")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("backlog.md")) return SAMPLE_BACKLOG as never;
      return "" as never;
    });
  });

  it("appends task in correct format: - [ ] [TAG] Title — desc", async () => {
    await addTaskCommand("Add user auth", {
      dir: "/tmp/test",
      tag: "FEAT",
      description: "OAuth2 login flow",
      position: "top",
    });

    // Should write to a .tmp file first
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("backlog.md.tmp"),
      expect.stringContaining("- [ ] [FEAT] Add user auth — OAuth2 login flow"),
      "utf-8",
    );
  });

  it("uses default tag FEAT when none specified", async () => {
    await addTaskCommand("New feature", { dir: "/tmp/test" });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      expect.stringContaining("- [ ] [FEAT] New feature"),
      "utf-8",
    );
  });

  it("uppercases the tag", async () => {
    await addTaskCommand("Fix bug", { dir: "/tmp/test", tag: "fix" });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      expect.stringContaining("- [ ] [FIX] Fix bug"),
      "utf-8",
    );
  });

  it("position=top places task before first checkbox entry", async () => {
    await addTaskCommand("Urgent task", {
      dir: "/tmp/test",
      position: "top",
    });

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    const lines = writtenContent.split("\n");

    // Find our new task and the first existing task
    const newTaskIdx = lines.findIndex((l) => l.includes("Urgent task"));
    const existingTaskIdx = lines.findIndex((l) => l.includes("Existing pending task"));

    expect(newTaskIdx).toBeGreaterThan(-1);
    expect(existingTaskIdx).toBeGreaterThan(-1);
    expect(newTaskIdx).toBeLessThan(existingTaskIdx);
  });

  it("position=bottom places task before first [x] entry", async () => {
    await addTaskCommand("Bottom task", {
      dir: "/tmp/test",
      position: "bottom",
    });

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    const lines = writtenContent.split("\n");

    const newTaskIdx = lines.findIndex((l) => l.includes("Bottom task"));
    const doneTaskIdx = lines.findIndex((l) => l.includes("- [x]"));

    expect(newTaskIdx).toBeGreaterThan(-1);
    expect(doneTaskIdx).toBeGreaterThan(-1);
    expect(newTaskIdx).toBeLessThan(doneTaskIdx);
  });

  it("uses atomic write via .tmp-then-rename", async () => {
    await addTaskCommand("Safe write task", { dir: "/tmp/test" });

    // First writes to .tmp file
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("backlog.md.tmp"),
      expect.any(String),
      "utf-8",
    );

    // Then renames .tmp to backlog.md
    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringContaining("backlog.md.tmp"),
      expect.stringContaining("backlog.md"),
    );

    // Rename should be called after write
    expect(mockRenameSync).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
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
