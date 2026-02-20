import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { readFileSync, appendFileSync, existsSync } from "fs";
import { configMigrateCommand } from "../config";

const mockReadFileSync = vi.mocked(readFileSync);
const mockAppendFileSync = vi.mocked(appendFileSync);
const mockExistsSync = vi.mocked(existsSync);

const USER_CONFIG = `export SKYNET_PROJECT_NAME="my-app"
export SKYNET_PROJECT_DIR="/home/user/my-app"
export SKYNET_DEV_DIR="/home/user/my-app/.dev"
export SKYNET_MAX_WORKERS=4
`;

const TEMPLATE_CONFIG = `# Project name identifier
export SKYNET_PROJECT_NAME="my-project"

# Project root directory
export SKYNET_PROJECT_DIR=""

# Dev state directory
export SKYNET_DEV_DIR=""

# Max parallel workers
export SKYNET_MAX_WORKERS=4

# Max parallel fixers
export SKYNET_MAX_FIXERS=2

# Stale task timeout in minutes
export SKYNET_STALE_MINUTES=45
`;

describe("configMigrateCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  it("detects missing variables by comparing template vs user config", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh") && !path.includes("templates"))
        return USER_CONFIG as never;
      return TEMPLATE_CONFIG as never;
    });

    const result = await configMigrateCommand({ dir: "/tmp/test" });

    expect(result).toContain("SKYNET_MAX_FIXERS");
    expect(result).toContain("SKYNET_STALE_MINUTES");
    expect(result).not.toContain("SKYNET_PROJECT_NAME");
    expect(result).not.toContain("SKYNET_MAX_WORKERS");
  });

  it("appends new variables with their default values and preceding comments", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh") && !path.includes("templates"))
        return USER_CONFIG as never;
      return TEMPLATE_CONFIG as never;
    });

    await configMigrateCommand({ dir: "/tmp/test" });

    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const appended = mockAppendFileSync.mock.calls[0][1] as string;

    // Should include comment + variable definition for each missing var
    expect(appended).toContain("# Max parallel fixers");
    expect(appended).toContain("export SKYNET_MAX_FIXERS=2");
    expect(appended).toContain("# Stale task timeout in minutes");
    expect(appended).toContain("export SKYNET_STALE_MINUTES=45");
  });

  it('reports "Added N new config variables: VAR1, VAR2" when variables are missing', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh") && !path.includes("templates"))
        return USER_CONFIG as never;
      return TEMPLATE_CONFIG as never;
    });

    await configMigrateCommand({ dir: "/tmp/test" });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");

    expect(logCalls).toContain("Added 2 new config variable");
    expect(logCalls).toContain("SKYNET_MAX_FIXERS");
    expect(logCalls).toContain("SKYNET_STALE_MINUTES");
  });

  it('reports "Config is up to date" when all variables are present', async () => {
    const fullConfig = `export SKYNET_PROJECT_NAME="my-app"
export SKYNET_PROJECT_DIR="/home/user/my-app"
export SKYNET_DEV_DIR="/home/user/my-app/.dev"
export SKYNET_MAX_WORKERS=4
export SKYNET_MAX_FIXERS=2
export SKYNET_STALE_MINUTES=45
`;

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh") && !path.includes("templates"))
        return fullConfig as never;
      return TEMPLATE_CONFIG as never;
    });

    const result = await configMigrateCommand({ dir: "/tmp/test" });

    expect(result).toEqual([]);
    expect(mockAppendFileSync).not.toHaveBeenCalled();

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join("\n");
    expect(logCalls).toContain("Config is up to date");
  });

  it("handles missing template file gracefully", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith(".dev/skynet.config.sh")) return true;
      // Template file does not exist
      return false;
    });

    await expect(
      configMigrateCommand({ dir: "/tmp/test" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Template skynet.config.sh not found"),
    );
  });

  it("handles missing user config file with helpful error message", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(
      configMigrateCommand({ dir: "/tmp/test" }),
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("skynet.config.sh not found"),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("skynet init"),
    );
  });
});
