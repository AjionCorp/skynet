import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { readFileSync, unlinkSync, existsSync } from "fs";
import { resumeCommand } from "../resume";

const mockReadFileSync = vi.mocked(readFileSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockExistsSync = vi.mocked(existsSync);

const CONFIG_CONTENT = [
  'export SKYNET_PROJECT_NAME="test-project"',
  'export SKYNET_PROJECT_DIR="/tmp/test-project"',
  'export SKYNET_DEV_DIR="/tmp/test-project/.dev"',
].join("\n");

describe("resumeCommand", () => {
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

  it("removes sentinel file when paused", async () => {
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

    await resumeCommand({ dir: "/tmp/test-project" });

    // Should delete the sentinel file
    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    const unlinkPath = String(mockUnlinkSync.mock.calls[0][0]);
    expect(unlinkPath).toContain("pipeline-paused");

    // Should show pause info and resume message
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Resuming pipeline");
    expect(logCalls).toContain("2026-02-20T10:00:00.000Z");
    expect(logCalls).toContain("testuser");
    expect(logCalls).toContain("Pipeline resumed");
  });

  it("is a no-op when not paused", async () => {
    await resumeCommand({ dir: "/tmp/test-project" });

    // Should NOT delete anything
    expect(mockUnlinkSync).not.toHaveBeenCalled();

    // Should show not-paused message
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Pipeline is not paused");
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

    await resumeCommand({ dir: "/tmp/test-project" });

    // Should still delete the sentinel
    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);

    // Should show generic resume message
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Resuming pipeline");
    expect(logCalls).toContain("Pipeline resumed");
  });

  it("throws when config file is missing", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(
      resumeCommand({ dir: "/tmp/test-project" }),
    ).rejects.toThrow("skynet.config.sh not found");
  });
});
