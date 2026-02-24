import { describe, it, expect } from "vitest";
import { sqlEscape } from "./sqliteQuery.js";

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
