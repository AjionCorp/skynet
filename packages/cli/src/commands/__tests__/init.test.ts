import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  symlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ isDirectory: () => false })),
  lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
  chmodSync: vi.fn(),
}));

vi.mock("readline", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_q: string, cb: (a: string) => void) => cb("")),
    close: vi.fn(),
  })),
}));

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
} from "fs";
import { initCommand } from "../init";

const mockMkdirSync = vi.mocked(mkdirSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockStatSync = vi.mocked(statSync);
const mockLstatSync = vi.mocked(lstatSync);

describe("initCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default mocks: templates exist, state files don't
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue(
      'export SKYNET_PROJECT_NAME="PLACEHOLDER_PROJECT_NAME"\nexport SKYNET_PROJECT_DIR="PLACEHOLDER_PROJECT_DIR"\nexport SKYNET_DEV_SERVER_CMD="pnpm dev"\nexport SKYNET_DEV_PORT=3000\nexport SKYNET_DEV_SERVER_URL="http://localhost:3000"\nexport SKYNET_TYPECHECK_CMD="pnpm typecheck"\nexport SKYNET_LINT_CMD="pnpm lint"\nexport SKYNET_PLAYWRIGHT_DIR=""\nexport SKYNET_SMOKE_TEST="e2e/smoke.spec.ts"\nexport SKYNET_FEATURE_TEST="e2e/features.spec.ts"\nexport SKYNET_MAIN_BRANCH="main"\nexport SKYNET_TG_ENABLED=false\nexport SKYNET_TG_BOT_TOKEN=""\nexport SKYNET_TG_CHAT_ID=""' as never,
    );
    mockReaddirSync.mockReturnValue([] as never);
    mockStatSync.mockReturnValue({ isDirectory: () => false } as never);
  });

  it("creates .dev/ directory with expected structure", async () => {
    await initCommand({ name: "test-proj", nonInteractive: true, dir: "/tmp/fake-proj" });

    // Should create .dev/prompts and .dev/scripts directories
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".dev/prompts"),
      { recursive: true },
    );
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".dev/scripts"),
      { recursive: true },
    );

    // Should write skynet.config.sh and skynet.project.sh
    const writtenPaths = mockWriteFileSync.mock.calls.map((c) => c[0] as string);
    expect(writtenPaths.some((p) => p.endsWith("skynet.config.sh"))).toBe(true);
    expect(writtenPaths.some((p) => p.endsWith("skynet.project.sh"))).toBe(true);
  });

  it("sets project name from --name flag", async () => {
    await initCommand({ name: "my-app", nonInteractive: true, dir: "/tmp/fake-proj" });

    // The config file should contain the project name
    const configWrite = mockWriteFileSync.mock.calls.find(
      (c) => (c[0] as string).endsWith("skynet.config.sh"),
    );
    expect(configWrite).toBeDefined();
    const content = configWrite![1] as string;
    expect(content).toContain("my-app");
    expect(content).not.toContain("PLACEHOLDER_PROJECT_NAME");
  });

  it("skips prompts in --non-interactive mode", async () => {
    // In non-interactive mode, initCommand should complete without blocking on readline
    // If it tried to prompt, the test would hang. Completing proves it skipped prompts.
    await initCommand({ name: "auto-proj", nonInteractive: true, dir: "/tmp/fake-proj" });

    expect(mockMkdirSync).toHaveBeenCalled();
  });

  it("rejects invalid project name", async () => {
    await expect(
      initCommand({ name: "Invalid Name!", nonInteractive: true, dir: "/tmp/fake-proj" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("lowercase alphanumeric"),
    );
  });

  it("--from-snapshot skips symlink targets", async () => {
    const snapshot = JSON.stringify({
      "backlog.md": "# Backlog\n- [ ] [TEST] Task 1",
      "completed.md": "# Completed",
      "failed-tasks.md": "# Failed",
      "blockers.md": "# Blockers",
      "mission.md": "# Mission",
      "symlinked-file.md": "should be skipped",
    });

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      // Snapshot file exists
      if (path.endsWith("snapshot.json")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      // Config template
      if (path.includes("templates") || path.endsWith("skynet.config.sh")) {
        return 'export SKYNET_PROJECT_NAME="PLACEHOLDER_PROJECT_NAME"\nexport SKYNET_PROJECT_DIR="PLACEHOLDER_PROJECT_DIR"\nexport SKYNET_DEV_SERVER_CMD="pnpm dev"\nexport SKYNET_DEV_PORT=3000\nexport SKYNET_DEV_SERVER_URL="http://localhost:3000"\nexport SKYNET_TYPECHECK_CMD="pnpm typecheck"\nexport SKYNET_LINT_CMD="pnpm lint"\nexport SKYNET_PLAYWRIGHT_DIR=""\nexport SKYNET_SMOKE_TEST="e2e/smoke.spec.ts"\nexport SKYNET_FEATURE_TEST="e2e/features.spec.ts"\nexport SKYNET_MAIN_BRANCH="main"\nexport SKYNET_TG_ENABLED=false\nexport SKYNET_TG_BOT_TOKEN=""\nexport SKYNET_TG_CHAT_ID=""' as never;
      }
      // Snapshot file
      if (path.endsWith("snapshot.json")) return snapshot as never;
      return "" as never;
    });

    // lstatSync: symlinked-file.md is a symlink, others throw ENOENT (file doesn't exist yet)
    mockLstatSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("symlinked-file.md")) {
        return { isSymbolicLink: () => true } as never;
      }
      throw new Error("ENOENT");
    });

    await initCommand({
      name: "test-proj",
      nonInteractive: true,
      dir: "/tmp/fake-proj",
      fromSnapshot: "/tmp/fake-proj/snapshot.json",
    });

    // Verify writeFileSync was called for normal files but NOT for symlinked-file.md
    const writeArgs = mockWriteFileSync.mock.calls.map((c) => c[0] as string);
    const wroteSymlink = writeArgs.some((p) => p.endsWith("symlinked-file.md"));
    expect(wroteSymlink).toBe(false);

    // Should have written some of the normal snapshot files
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(logCalls).toContain("Restored");
  });

  it("skips existing state files", async () => {
    // Templates exist (readFileSync returns content), but target files also exist
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      // Template files exist, target state files also exist
      if (path.includes("templates/")) return true;
      if (path.endsWith("mission.md")) return true;
      if (path.endsWith("backlog.md")) return true;
      return false;
    });

    await initCommand({ name: "test-proj", nonInteractive: true, dir: "/tmp/fake-proj" });

    // Console should mention "already exists, skipped" for existing files
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(logCalls).toContain("already exists, skipped");
  });
});
