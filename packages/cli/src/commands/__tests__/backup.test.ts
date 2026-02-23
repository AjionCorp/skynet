import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 1024 })),
  readFileSync: vi.fn(() => ""),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
  spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") })),
}));

vi.mock("../../utils/loadConfig", () => ({
  loadConfig: vi.fn(),
}));

import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { loadConfig } from "../../utils/loadConfig";
import { backupCommand } from "../backup";

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockSpawnSync = vi.mocked(spawnSync);
const mockLoadConfig = vi.mocked(loadConfig);
const mockReaddirSync = vi.mocked(readdirSync);
const mockStatSync = vi.mocked(statSync);

describe("backupCommand", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("creates backup directory if missing", async () => {
    mockLoadConfig.mockReturnValue({
      SKYNET_DEV_DIR: "/tmp/test/.dev",
    });
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.db")) return true;
      return false;
    });
    mockSpawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), pid: 0, output: [], signal: null } as never);
    mockStatSync.mockReturnValue({ size: 2048 } as never);
    mockReaddirSync.mockReturnValue([] as never);

    await backupCommand({ dir: "/tmp/test" });

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("db-backups"),
      { recursive: true }
    );
  });

  it("calls sqlite3 .backup with correct path", async () => {
    mockLoadConfig.mockReturnValue({
      SKYNET_DEV_DIR: "/tmp/test/.dev",
    });
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.db")) return true;
      return false;
    });
    mockSpawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), pid: 0, output: [], signal: null } as never);
    mockStatSync.mockReturnValue({ size: 2048 } as never);
    mockReaddirSync.mockReturnValue([] as never);

    await backupCommand({ dir: "/tmp/test" });

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "sqlite3",
      expect.arrayContaining([expect.stringContaining("skynet.db")]),
      expect.objectContaining({ timeout: 30000 })
    );
  });

  it("exits with error if DB not found", async () => {
    mockLoadConfig.mockReturnValue({
      SKYNET_DEV_DIR: "/tmp/test/.dev",
    });
    mockExistsSync.mockReturnValue(false);

    await expect(backupCommand({ dir: "/tmp/test" })).rejects.toThrow(
      "process.exit"
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(errorCalls).toContain("not found");
  });
});
