import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from "fs";
import { readFile } from "./readFile.js";

const mockReadFileSync = vi.mocked(readFileSync);

describe("readFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns file content when file exists", () => {
    mockReadFileSync.mockReturnValue("hello world" as never);
    expect(readFile("/tmp/test.txt")).toBe("hello world");
    expect(mockReadFileSync).toHaveBeenCalledWith("/tmp/test.txt", "utf-8");
  });

  it("returns empty string when file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    expect(readFile("/tmp/nonexistent.txt")).toBe("");
  });
});
