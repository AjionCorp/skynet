import { describe, it, expect, vi, beforeEach } from "vitest";
import { isProcessRunning } from "./isProcessRunning.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

import { readFileSync } from "fs";
const mockReadFileSync = vi.mocked(readFileSync);

describe("isProcessRunning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not running when lock file cannot be read", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const result = isProcessRunning("/tmp/test.lock");
    expect(result.running).toBe(false);
  });

  it("returns running with PID for active process", () => {
    // First call (join path) throws, second call (file path) returns PID
    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error("ENOENT");
      return String(process.pid) as never;
    });
    const result = isProcessRunning("/tmp/test.lock");
    expect(result.running).toBe(true);
    expect(result.pid).toBe(String(process.pid));
  });

  it("returns not running for dead process PID", () => {
    // First call (join path) throws, second call (file path) returns dead PID
    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error("ENOENT");
      return "99999999" as never;
    });
    const result = isProcessRunning("/tmp/test.lock");
    expect(result.running).toBe(false);
  });

  it("returns not running for non-numeric PID", () => {
    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error("ENOENT");
      return "not-a-pid" as never;
    });
    const result = isProcessRunning("/tmp/test.lock");
    expect(result.running).toBe(false);
  });
});
