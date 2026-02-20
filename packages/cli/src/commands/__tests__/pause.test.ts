import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { pauseCommand } from "../pause";

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockExistsSync = vi.mocked(existsSync);

const CONFIG_CONTENT = [
  'export SKYNET_PROJECT_NAME="test-project"',
  'export SKYNET_PROJECT_DIR="/tmp/test-project"',
  'export SKYNET_DEV_DIR="/tmp/test-project/.dev"',
].join("\n");

describe("pauseCommand", () => {
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
  });

  it("creates pipeline-paused sentinel with correct JSON shape", async () => {
    await pauseCommand({ dir: "/tmp/test-project" });

    // Should write to tmp file first (atomic write pattern)
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writeCall = mockWriteFileSync.mock.calls[0];
    const writtenPath = String(writeCall[0]);
    expect(writtenPath).toContain("pipeline-paused.tmp");

    // Verify JSON shape has pausedAt and pausedBy
    const writtenContent = JSON.parse(String(writeCall[1]).trim());
    expect(writtenContent).toHaveProperty("pausedAt");
    expect(writtenContent).toHaveProperty("pausedBy");
    expect(typeof writtenContent.pausedAt).toBe("string");
    expect(typeof writtenContent.pausedBy).toBe("string");

    // Should rename tmp to final (atomic)
    expect(mockRenameSync).toHaveBeenCalledTimes(1);
    const renameCall = mockRenameSync.mock.calls[0];
    expect(String(renameCall[0])).toContain("pipeline-paused.tmp");
    expect(String(renameCall[1])).toContain("pipeline-paused");
    expect(String(renameCall[1])).not.toContain(".tmp");

    // Should log success
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Pipeline paused.");
    expect(logCalls).toContain("Run 'skynet resume' to unpause.");
  });

  it("is a no-op when already paused and shows info", async () => {
    const existingSentinel = JSON.stringify({
      pausedAt: "2026-02-20T10:00:00.000Z",
      pausedBy: "testuser",
    });

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("pipeline-paused")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("pipeline-paused")) return existingSentinel as never;
      return "" as never;
    });

    await pauseCommand({ dir: "/tmp/test-project" });

    // Should NOT write anything
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockRenameSync).not.toHaveBeenCalled();

    // Should show already-paused info
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("already paused");
    expect(logCalls).toContain("2026-02-20T10:00:00.000Z");
    expect(logCalls).toContain("testuser");
  });

  it("handles corrupt sentinel file gracefully", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("pipeline-paused")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("pipeline-paused")) return "not valid json" as never;
      return "" as never;
    });

    await pauseCommand({ dir: "/tmp/test-project" });

    // Should NOT write anything
    expect(mockWriteFileSync).not.toHaveBeenCalled();

    // Should show generic already-paused message
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("already paused");
    expect(logCalls).toContain("sentinel exists");
  });

  it("throws when config file is missing", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(
      pauseCommand({ dir: "/tmp/test-project" }),
    ).rejects.toThrow("skynet.config.sh not found");
  });
});
