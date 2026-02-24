import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig } from "./loadConfig.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

import { existsSync, readFileSync } from "fs";
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe("loadConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it("returns null when config file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const result = loadConfig("/some/project");
    expect(result).toBeNull();
  });

  it("parses double-quoted export lines", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'export SKYNET_PROJECT_NAME="my-project"\nexport SKYNET_MAX_WORKERS="4"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_PROJECT_NAME).toBe("my-project");
    expect(result!.SKYNET_MAX_WORKERS).toBe("4");
  });

  it("ignores unquoted values (shell metacharacter safety)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "export SKYNET_MAX_WORKERS=4\nexport SKYNET_PROJECT_NAME=\"my-project\"\n" as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_MAX_WORKERS).toBeUndefined();
    expect(result!.SKYNET_PROJECT_NAME).toBe("my-project");
  });

  it("ignores comment lines", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '# This is a comment\nexport SKYNET_FOO="bar"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_FOO).toBe("bar");
  });

  it("parses lines with or without export keyword", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'SKYNET_FOO="bar"\nexport SKYNET_BAR="baz"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_FOO).toBe("bar");
    expect(result!.SKYNET_BAR).toBe("baz");
  });

  it("expands $HOME from ALLOWED_ENV", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'export SKYNET_PATH="$HOME/projects"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_PATH).toBe(`${process.env.HOME}/projects`);
  });

  it("replaces $UNKNOWN_VAR with empty string", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'export SKYNET_PATH="$UNKNOWN_VAR/projects"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_PATH).toBe("/projects");
  });

  it("sanitizeEnvValue strips shell metacharacters from expanded values", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/home/user;rm -rf /";
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'export SKYNET_PATH="$HOME/projects"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_PATH).not.toContain(";");
    expect(result!.SKYNET_PATH).not.toContain("|");
    expect(result!.SKYNET_PATH).not.toContain("&");
    expect(result!.SKYNET_PATH).not.toContain("$");
    process.env.HOME = originalHome;
  });

  it("$PATH is not in ALLOWED_ENV and becomes empty string", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'export SKYNET_EXTRA="$PATH"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_EXTRA).toBe("");
  });

  it("config values referencing other config vars work", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'export SKYNET_DEV_DIR="/tmp/project/.dev"\nexport SKYNET_SCRIPTS="$SKYNET_DEV_DIR/scripts"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_DEV_DIR).toBe("/tmp/project/.dev");
    expect(result!.SKYNET_SCRIPTS).toBe("/tmp/project/.dev/scripts");
  });

  it("ALLOWED_ENV restricts which env vars can be expanded", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'export SKYNET_VAL="$HOME"\nexport SKYNET_SECRET="$SECRET_KEY"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_VAL).toBe(process.env.HOME);
    expect(result!.SKYNET_SECRET).toBe("");
  });

  it("single-quoted values are literal (no variable expansion)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "export SKYNET_FOO='bar $HOME'\n" as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_FOO).toBe("bar $HOME");
  });

  it("rejects unquoted values with shell metacharacters", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "export SKYNET_BAD=hello;rm -rf /\nexport SKYNET_GOOD=\"safe\"\n" as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_BAD).toBeUndefined();
    expect(result!.SKYNET_GOOD).toBe("safe");
  });

  it("double-quoted values work with escaped characters", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'export SKYNET_ESC="path with \\"quotes\\""\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_ESC).toBe('path with "quotes"');
  });

  it("single-quoted values preserve all characters literally", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "export SKYNET_LIT='hello $HOME \\n'\n" as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_LIT).toBe("hello $HOME \\n");
  });

  it("resolves forward references (later var references earlier var defined after it)", () => {
    mockExistsSync.mockReturnValue(true);
    // SKYNET_FULL references SKYNET_BASE, but SKYNET_BASE is defined later in the file.
    // The second pass should resolve this forward reference.
    mockReadFileSync.mockReturnValue(
      'export SKYNET_FULL="$SKYNET_BASE/sub"\nexport SKYNET_BASE="/opt/skynet"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_BASE).toBe("/opt/skynet");
    expect(result!.SKYNET_FULL).toBe("/opt/skynet/sub");
  });

  it("resolves forward references with ${VAR} syntax", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'export SKYNET_PATH="${SKYNET_ROOT}/bin"\nexport SKYNET_ROOT="/usr/local"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_ROOT).toBe("/usr/local");
    expect(result!.SKYNET_PATH).toBe("/usr/local/bin");
  });
});
