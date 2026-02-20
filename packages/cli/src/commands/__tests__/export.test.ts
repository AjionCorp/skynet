import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { readFileSync, writeFileSync, existsSync } from "fs";
import { exportCommand } from "../export";

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);

const CONFIG_CONTENT = `export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_DIR="/tmp/test"
export SKYNET_DEV_DIR="/tmp/test/.dev"
`;

describe("exportCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    mockExistsSync.mockReturnValue(true);
  });

  it("JSON output contains all expected keys", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("backlog.md")) return "# Backlog\n- task 1" as never;
      if (path.endsWith("completed.md")) return "# Completed" as never;
      if (path.endsWith("failed-tasks.md")) return "" as never;
      if (path.endsWith("blockers.md")) return "" as never;
      if (path.endsWith("mission.md")) return "# Mission" as never;
      if (path.endsWith("events.log")) return "event1\nevent2" as never;
      return "" as never;
    });

    await exportCommand({ dir: "/tmp/test" });

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);

    const expectedKeys = [
      "backlog.md",
      "completed.md",
      "failed-tasks.md",
      "blockers.md",
      "mission.md",
      "skynet.config.sh",
      "events.log",
    ];
    for (const key of expectedKeys) {
      expect(writtenContent).toHaveProperty(key);
    }
  });

  it("--output flag writes to custom path", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      return "" as never;
    });

    await exportCommand({ dir: "/tmp/test", output: "/tmp/custom-snapshot.json" });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/custom-snapshot.json",
      expect.any(String),
      "utf-8",
    );
  });

  it("handles missing .dev/ files gracefully with empty string value", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      throw new Error("ENOENT: no such file or directory");
    });

    await exportCommand({ dir: "/tmp/test" });

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);

    // State files that aren't skynet.config.sh should be empty strings
    expect(writtenContent["backlog.md"]).toBe("");
    expect(writtenContent["completed.md"]).toBe("");
    expect(writtenContent["failed-tasks.md"]).toBe("");
    expect(writtenContent["blockers.md"]).toBe("");
    expect(writtenContent["mission.md"]).toBe("");
    expect(writtenContent["events.log"]).toBe("");
  });
});
