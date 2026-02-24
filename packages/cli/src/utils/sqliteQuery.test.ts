import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SpawnSyncReturns } from "child_process";

// ── Pure function tests (no mocking needed) ────────────────────────────

// Import sqlEscape and sqlInt directly — they are pure functions
import { sqlEscape, sqlInt, sqlLikeEscape } from "./sqliteQuery.js";

describe("sqlEscape", () => {
  it("doubles single quotes", () => {
    expect(sqlEscape("it's")).toBe("it''s");
  });

  it("escapes backslashes", () => {
    expect(sqlEscape("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("removes NUL bytes", () => {
    expect(sqlEscape("hello\0world")).toBe("helloworld");
  });

  it("replaces newlines with spaces", () => {
    expect(sqlEscape("line1\nline2")).toBe("line1 line2");
  });

  it("removes carriage returns", () => {
    expect(sqlEscape("line1\r\nline2")).toBe("line1 line2");
  });

  it("handles combined injection attempt", () => {
    const input = "'; DROP TABLE tasks; --";
    const escaped = sqlEscape(input);
    expect(escaped).toBe("''; DROP TABLE tasks; --");
  });

  it("passes through safe strings unchanged", () => {
    expect(sqlEscape("hello world 123")).toBe("hello world 123");
  });

  it("handles empty string", () => {
    expect(sqlEscape("")).toBe("");
  });

  it("handles multiple single quotes", () => {
    expect(sqlEscape("it''s already ''escaped''")).toBe("it''''s already ''''escaped''''");
  });

  it("handles dot-command injection via newlines", () => {
    // Newlines are dangerous because they could inject .commands to sqlite3
    const input = "value\n.shell rm -rf /";
    const escaped = sqlEscape(input);
    expect(escaped).not.toContain("\n");
    expect(escaped).toBe("value .shell rm -rf /");
  });
});

describe("sqlLikeEscape", () => {
  it("escapes % to \\%", () => {
    expect(sqlLikeEscape("100%")).toBe("100\\%");
  });

  it("escapes _ to \\_", () => {
    expect(sqlLikeEscape("some_value")).toBe("some\\_value");
  });

  it("also applies base sqlEscape (single quotes, NUL, etc)", () => {
    expect(sqlLikeEscape("it's 100%")).toBe("it''s 100\\%");
    expect(sqlLikeEscape("val\0ue%")).toBe("value\\%");
  });

  it("handles combined wildcards", () => {
    expect(sqlLikeEscape("%_test_%")).toBe("\\%\\_test\\_\\%");
  });

  it("passes through safe strings unchanged", () => {
    expect(sqlLikeEscape("hello world")).toBe("hello world");
  });
});

describe("sqlInt", () => {
  it("returns integer for valid integer string", () => {
    expect(sqlInt("42")).toBe(42);
  });

  it("returns integer for valid number", () => {
    expect(sqlInt(100)).toBe(100);
  });

  it("returns 0 for NaN string", () => {
    expect(sqlInt("not-a-number")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(sqlInt("")).toBe(0);
  });

  it("returns 0 for Infinity", () => {
    expect(sqlInt(Infinity)).toBe(0);
  });

  it("returns 0 for -Infinity", () => {
    expect(sqlInt(-Infinity)).toBe(0);
  });

  it("returns 0 for float values", () => {
    expect(sqlInt(3.14)).toBe(0);
    expect(sqlInt("3.14")).toBe(0);
  });

  it("handles negative integers", () => {
    expect(sqlInt(-5)).toBe(-5);
    expect(sqlInt("-5")).toBe(-5);
  });

  it("returns 0 for undefined coerced to NaN", () => {
    expect(sqlInt(undefined as unknown as number)).toBe(0);
  });
});

// ── Tests requiring mocking (spawnSync / existsSync) ────────────────────

// Use dynamic import so vi.mock hoisting applies before module resolution
vi.mock("child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Dynamic import after mocks are registered
const { spawnSync } = await import("child_process");
const { existsSync } = await import("fs");
const mod = await import("./sqliteQuery.js");

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedExistsSync = vi.mocked(existsSync);

describe("sqliteQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when database file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(() => mod.sqliteQuery("/dev", "SELECT 1;")).toThrow("skynet.db not found");
  });

  it("returns stdout on successful query", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "hello",
      stderr: "",
    } as unknown as SpawnSyncReturns<string>);

    const result = mod.sqliteQuery("/dev", "SELECT 'hello';");
    expect(result).toBe("hello");
  });

  it("throws on non-zero exit status", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Error: no such table: foo",
    } as unknown as SpawnSyncReturns<string>);

    expect(() => mod.sqliteQuery("/dev", "SELECT * FROM foo;")).toThrow("sqlite3 query failed (exit 1)");
  });

  it("trims stdout whitespace", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "  result  \n",
      stderr: "",
    } as unknown as SpawnSyncReturns<string>);

    expect(mod.sqliteQuery("/dev", "SELECT 1;")).toBe("result");
  });
});

describe("sqliteRows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array for empty result", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as unknown as SpawnSyncReturns<string>);

    expect(mod.sqliteRows("/dev", "SELECT * FROM empty;")).toEqual([]);
  });

  it("splits rows by newline and fields by unit separator", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "a\x1fb\x1fc\nd\x1fe\x1ff",
      stderr: "",
    } as unknown as SpawnSyncReturns<string>);

    const rows = mod.sqliteRows("/dev", "SELECT * FROM tasks;");
    expect(rows).toEqual([["a", "b", "c"], ["d", "e", "f"]]);
  });

  it("handles single row with single column", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "42",
      stderr: "",
    } as unknown as SpawnSyncReturns<string>);

    expect(mod.sqliteRows("/dev", "SELECT COUNT(*) FROM tasks;")).toEqual([["42"]]);
  });
});

describe("sqliteScalar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns first line of output", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "42\n99",
      stderr: "",
    } as unknown as SpawnSyncReturns<string>);

    expect(mod.sqliteScalar("/dev", "SELECT COUNT(*) FROM tasks;")).toBe("42");
  });

  it("returns empty string for empty result", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    } as unknown as SpawnSyncReturns<string>);

    expect(mod.sqliteScalar("/dev", "SELECT NULL;")).toBe("");
  });
});

describe("isSqliteReady", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when tasks table is accessible", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: "5",
      stderr: "",
    } as unknown as SpawnSyncReturns<string>);

    expect(mod.isSqliteReady("/dev")).toBe(true);
  });

  it("returns false when database does not exist", () => {
    mockedExistsSync.mockReturnValue(false);

    expect(mod.isSqliteReady("/dev")).toBe(false);
  });

  it("returns false when query fails", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Error: no such table: tasks",
    } as unknown as SpawnSyncReturns<string>);

    expect(mod.isSqliteReady("/dev")).toBe(false);
  });
});
