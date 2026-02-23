import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 1024 })),
  readFileSync: vi.fn(() => ""),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" })),
}));

vi.mock("../../utils/loadConfig", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../utils/isProcessRunning", () => ({
  isProcessRunning: vi.fn(() => ({ running: false, pid: "" })),
}));

import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { loadConfig } from "../../utils/loadConfig";
import { isProcessRunning } from "../../utils/isProcessRunning";
import { restoreDbCommand } from "../restore-db";

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockSpawnSync = vi.mocked(spawnSync);
const mockLoadConfig = vi.mocked(loadConfig);
const _mockCopyFileSync = vi.mocked(copyFileSync);
const mockStatSync = vi.mocked(statSync);
const mockIsProcessRunning = vi.mocked(isProcessRunning);

describe("restoreDbCommand", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("refuses to restore when workers are running", async () => {
    mockLoadConfig.mockReturnValue({
      SKYNET_DEV_DIR: "/tmp/test/.dev",
      SKYNET_LOCK_PREFIX: "/tmp/skynet-test",
      SKYNET_MAX_WORKERS: "2",
      SKYNET_PROJECT_NAME: "test",
    });
    // Backup file exists
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("backup.db")) return true;
      return false;
    });
    // Integrity check passes
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "ok", stderr: "", pid: 0, output: [], signal: null } as never);
    // Workers are running
    mockIsProcessRunning.mockReturnValue({ running: true, pid: "12345" });

    await expect(
      restoreDbCommand("backup.db", { dir: "/tmp/test" })
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(errorCalls).toContain("running");
  });

  it("validates backup integrity before restore", async () => {
    mockLoadConfig.mockReturnValue({
      SKYNET_DEV_DIR: "/tmp/test/.dev",
      SKYNET_LOCK_PREFIX: "/tmp/skynet-test",
      SKYNET_MAX_WORKERS: "2",
      SKYNET_PROJECT_NAME: "test",
    });
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("backup.db")) return true;
      return false;
    });
    // Integrity check returns "corrupt"
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "corrupt", stderr: "", pid: 0, output: [], signal: null } as never);
    mockIsProcessRunning.mockReturnValue({ running: false, pid: "" });

    await expect(
      restoreDbCommand("backup.db", { dir: "/tmp/test" })
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(errorCalls).toContain("integrity");
  });

  it("creates pre-restore backup of current DB", async () => {
    mockLoadConfig.mockReturnValue({
      SKYNET_DEV_DIR: "/tmp/test/.dev",
      SKYNET_LOCK_PREFIX: "/tmp/skynet-test",
      SKYNET_MAX_WORKERS: "2",
      SKYNET_PROJECT_NAME: "test",
    });
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("backup.db")) return true;
      if (path.endsWith("skynet.db")) return true; // current DB exists
      return false;
    });
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "ok", stderr: "", pid: 0, output: [], signal: null } as never);
    mockStatSync.mockReturnValue({ size: 4096 } as never);
    mockIsProcessRunning.mockReturnValue({ running: false, pid: "" });

    await restoreDbCommand("backup.db", { dir: "/tmp/test" });

    // Should create pre-restore backup directory
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("db-backups"),
      { recursive: true }
    );
    // Should call spawnSync for the pre-restore backup
    const backupCalls = mockSpawnSync.mock.calls.filter(
      ([cmd, args]) => cmd === "sqlite3" && Array.isArray(args) && args.some(a => String(a).includes(".backup"))
    );
    expect(backupCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("exits with error if restore file not found", async () => {
    mockLoadConfig.mockReturnValue({
      SKYNET_DEV_DIR: "/tmp/test/.dev",
      SKYNET_LOCK_PREFIX: "/tmp/skynet-test",
      SKYNET_MAX_WORKERS: "2",
      SKYNET_PROJECT_NAME: "test",
    });
    mockExistsSync.mockReturnValue(false);

    await expect(
      restoreDbCommand("nonexistent.db", { dir: "/tmp/test" })
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(errorCalls).toContain("not found");
  });
});
