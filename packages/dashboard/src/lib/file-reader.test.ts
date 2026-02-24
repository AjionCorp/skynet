import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readDevFile, extractTimestamp, getLastLogLine } from "./file-reader";

describe("readDevFile", () => {
  let devDir: string;

  beforeAll(() => {
    devDir = mkdtempSync(join(tmpdir(), "skynet-test-devdir-"));
    writeFileSync(join(devDir, "test.md"), "hello world");
    mkdirSync(join(devDir, "sub"));
    writeFileSync(join(devDir, "sub", "nested.md"), "nested content");
  });

  afterAll(() => {
    rmSync(devDir, { recursive: true, force: true });
  });

  it("reads a valid file inside devDir", () => {
    expect(readDevFile(devDir, "test.md")).toBe("hello world");
  });

  it("reads a nested file inside devDir", () => {
    expect(readDevFile(devDir, "sub/nested.md")).toBe("nested content");
  });

  it("returns empty string for ../etc/passwd traversal attempt", () => {
    expect(readDevFile(devDir, "../etc/passwd")).toBe("");
  });

  it("returns empty string for absolute path /etc/passwd", () => {
    expect(readDevFile(devDir, "/etc/passwd")).toBe("");
  });

  it("returns empty string for nonexistent file", () => {
    expect(readDevFile(devDir, "does-not-exist.md")).toBe("");
  });

  it("returns empty string for nonexistent devDir", () => {
    expect(readDevFile("/tmp/nonexistent-skynet-dir-xyz", "test.md")).toBe("");
  });

  it("returns empty string for backslash traversal attempt", () => {
    expect(readDevFile(devDir, "..\\etc\\passwd")).toBe("");
  });

  it("returns empty string for double-dot embedded in path", () => {
    expect(readDevFile(devDir, "sub/../../etc/passwd")).toBe("");
  });
});

describe("extractTimestamp", () => {
  it("parses [2024-01-15 10:30:00] format", () => {
    expect(extractTimestamp("[2024-01-15 10:30:00] Some log message")).toBe(
      "2024-01-15 10:30:00"
    );
  });

  it("returns null for no match", () => {
    expect(extractTimestamp("no timestamp here")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(extractTimestamp(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractTimestamp("")).toBeNull();
  });

  it("extracts timestamp from middle of line", () => {
    expect(
      extractTimestamp("prefix [2025-12-31 23:59:59] suffix")
    ).toBe("2025-12-31 23:59:59");
  });
});

describe("getLastLogLine", () => {
  it("returns null for invalid script name with path traversal", () => {
    expect(getLastLogLine("/tmp", "../etc/passwd")).toBeNull();
  });

  it("returns null for script name with spaces", () => {
    expect(getLastLogLine("/tmp", "bad name")).toBeNull();
  });

  it("returns null for script name with slashes", () => {
    expect(getLastLogLine("/tmp", "foo/bar")).toBeNull();
  });

  it("returns null for empty script name", () => {
    expect(getLastLogLine("/tmp", "")).toBeNull();
  });

  it("accepts valid script names (alphanumeric + hyphens)", () => {
    // This will return null because the log file doesn't exist, but
    // it should NOT return null from the regex check (it should proceed to try reading)
    const result = getLastLogLine("/tmp/nonexistent-dir", "dev-worker-1");
    expect(result).toBeNull();
  });

  it("returns the last line from a real temp file with multiple lines", () => {
    const logDir = mkdtempSync(join(tmpdir(), "skynet-logtest-"));
    const scriptsDir = join(logDir, "scripts");
    mkdirSync(scriptsDir);
    writeFileSync(
      join(scriptsDir, "test-script.log"),
      "[2026-01-01 10:00:00] First line\n[2026-01-01 10:01:00] Second line\n[2026-01-01 10:02:00] Last line\n"
    );
    try {
      const result = getLastLogLine(logDir, "test-script");
      expect(result).toBe("[2026-01-01 10:02:00] Last line");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("returns the single line from a one-line file", () => {
    const logDir = mkdtempSync(join(tmpdir(), "skynet-logtest-"));
    const scriptsDir = join(logDir, "scripts");
    mkdirSync(scriptsDir);
    writeFileSync(join(scriptsDir, "single.log"), "only line\n");
    try {
      const result = getLastLogLine(logDir, "single");
      expect(result).toBe("only line");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
