import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ size: 0 })),
}));

vi.mock("readline", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_q: string, cb: (a: string) => void) => cb("y")),
    close: vi.fn(),
  })),
}));

import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { importCommand } from "../import";

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);

const CONFIG_CONTENT = `export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_DIR="/tmp/test"
export SKYNET_DEV_DIR="/tmp/test/.dev"
`;

const VALID_SNAPSHOT = JSON.stringify({
  "backlog.md": "# Backlog\n- task 1",
  "completed.md": "# Completed",
  "failed-tasks.md": "",
  "blockers.md": "",
  "mission.md": "# Mission",
  "skynet.config.sh": 'export SKYNET_PROJECT_NAME="test"',
});

function setupMocks(snapshotContent: string, existingFiles: Record<string, string> = {}) {
  mockExistsSync.mockImplementation((p) => {
    const path = String(p);
    if (path.endsWith("skynet.config.sh")) return true;
    if (path.endsWith("snapshot.json")) return true;
    for (const key of Object.keys(existingFiles)) {
      if (path.endsWith(key)) return true;
    }
    return false;
  });

  mockReadFileSync.mockImplementation((p) => {
    const path = String(p);
    if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
    if (path.endsWith("snapshot.json")) return snapshotContent as never;
    for (const [key, value] of Object.entries(existingFiles)) {
      if (path.endsWith(key)) return value as never;
    }
    return "" as never;
  });

  mockStatSync.mockReturnValue({ size: 100 } as never);
}

describe("importCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  it("validates snapshot JSON has expected keys", async () => {
    const incompleteSnapshot = JSON.stringify({
      "backlog.md": "# Backlog",
    });

    setupMocks(incompleteSnapshot);

    await expect(
      importCommand("/tmp/snapshot.json", { dir: "/tmp/test" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("missing expected keys"),
    );
  });

  it("rejects invalid JSON", async () => {
    setupMocks("not valid json {{{");

    await expect(
      importCommand("/tmp/snapshot.json", { dir: "/tmp/test" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse snapshot file as JSON"),
    );
  });

  it("--dry-run shows diff without writing", async () => {
    setupMocks(VALID_SNAPSHOT);

    await importCommand("/tmp/snapshot.json", { dir: "/tmp/test", dryRun: true });

    expect(mockWriteFileSync).not.toHaveBeenCalled();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Dry run");
  });

  it("--merge appends to .md files instead of overwriting", async () => {
    const existingFiles = {
      "backlog.md": "# Existing Backlog",
      "completed.md": "# Existing Completed",
    };

    setupMocks(VALID_SNAPSHOT, existingFiles);

    await importCommand("/tmp/snapshot.json", {
      dir: "/tmp/test",
      merge: true,
      force: true,
    });

    // Verify backlog.md was merged (appended, not overwritten)
    const backlogWrite = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("backlog.md"),
    );
    expect(backlogWrite).toBeDefined();
    const writtenContent = backlogWrite![1] as string;
    expect(writtenContent).toContain("# Existing Backlog");
    expect(writtenContent).toContain("# Backlog");
  });

  it("--force skips confirmation prompt", async () => {
    setupMocks(VALID_SNAPSHOT);

    await importCommand("/tmp/snapshot.json", {
      dir: "/tmp/test",
      force: true,
    });

    // Files should be written without confirmation
    expect(mockWriteFileSync).toHaveBeenCalled();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Imported");
  });
});
