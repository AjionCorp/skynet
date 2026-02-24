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

  it("parses unquoted export lines", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "export SKYNET_MAX_WORKERS=4\n" as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_MAX_WORKERS).toBe("4");
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

  it("ignores non-export lines", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'SKYNET_FOO="bar"\nexport SKYNET_BAR="baz"\n' as never
    );
    const result = loadConfig("/some/project");
    expect(result).not.toBeNull();
    expect(result!.SKYNET_FOO).toBeUndefined();
    expect(result!.SKYNET_BAR).toBe("baz");
  });
});
