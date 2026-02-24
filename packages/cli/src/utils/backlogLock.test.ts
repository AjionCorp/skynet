import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
}));

import { mkdirSync, rmSync, statSync } from "fs";
import { acquireBacklogLock, releaseBacklogLock } from "./backlogLock.js";

const mockMkdirSync = vi.mocked(mkdirSync);
const mockRmSync = vi.mocked(rmSync);
const mockStatSync = vi.mocked(statSync);

describe("acquireBacklogLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acquires lock successfully when mkdir succeeds", async () => {
    mockMkdirSync.mockReturnValue(undefined);
    const result = await acquireBacklogLock("/tmp/test-lock", 1, 10);
    expect(result).toBe(true);
    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/test-lock");
  });

  it("returns false when lock is held (mkdir EEXIST)", async () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    mockMkdirSync.mockImplementation(() => { throw eexist; });
    // statSync returns a fresh lock (not stale)
    mockStatSync.mockReturnValue({ mtimeMs: Date.now() } as never);
    const result = await acquireBacklogLock("/tmp/test-lock", 2, 10);
    expect(result).toBe(false);
  });

  it("breaks stale lock older than 30s", async () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    let callCount = 0;
    mockMkdirSync.mockImplementation(() => {
      callCount++;
      // First call fails (lock held), then after stale break, succeed
      if (callCount <= 1) throw eexist;
      return undefined;
    });
    // statSync reports a lock that is 60s old (stale)
    mockStatSync.mockReturnValue({ mtimeMs: Date.now() - 60_000 } as never);
    const result = await acquireBacklogLock("/tmp/test-lock", 1, 10);
    expect(result).toBe(true);
    expect(mockRmSync).toHaveBeenCalledWith("/tmp/test-lock", { recursive: true, force: true });
  });

  it("does not break fresh lock", async () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    mockMkdirSync.mockImplementation(() => { throw eexist; });
    // statSync reports a lock that is only 5s old (fresh)
    mockStatSync.mockReturnValue({ mtimeMs: Date.now() - 5_000 } as never);
    const result = await acquireBacklogLock("/tmp/test-lock", 1, 10);
    expect(result).toBe(false);
    // rmSync should NOT have been called since lock is fresh
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("handles concurrent acquire attempts (stat throws, retry mkdir)", async () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    let mkdirCallCount = 0;
    mockMkdirSync.mockImplementation(() => {
      mkdirCallCount++;
      // First call: lock held. Second call after stat throws (lock gone): succeed
      if (mkdirCallCount <= 1) throw eexist;
      return undefined;
    });
    // statSync throws ENOENT (lock dir disappeared between mkdir and stat)
    mockStatSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const result = await acquireBacklogLock("/tmp/test-lock", 1, 10);
    // Should succeed because statSync failure triggers a retry mkdir
    expect(result).toBe(true);
  });
});

describe("releaseBacklogLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes the lock directory", () => {
    releaseBacklogLock("/tmp/test-lock");
    expect(mockRmSync).toHaveBeenCalledWith("/tmp/test-lock", { recursive: true, force: true });
  });

  it("does not throw when rmSync fails", () => {
    mockRmSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(() => releaseBacklogLock("/tmp/test-lock")).not.toThrow();
  });

  // TEST-P2-3: Boundary tests for lock acquisition/release
  it("re-acquires lock successfully after release", async () => {
    let callCount = 0;
    mockMkdirSync.mockImplementation(() => {
      callCount++;
      return undefined;
    });

    // Acquire
    const first = await acquireBacklogLock("/tmp/test-lock", 1, 10);
    expect(first).toBe(true);

    // Release
    releaseBacklogLock("/tmp/test-lock");
    expect(mockRmSync).toHaveBeenCalledWith("/tmp/test-lock", { recursive: true, force: true });

    // Re-acquire
    const second = await acquireBacklogLock("/tmp/test-lock", 1, 10);
    expect(second).toBe(true);
    expect(callCount).toBe(2);
  });

  it("releasing when lock is not held does not throw", () => {
    mockRmSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(() => releaseBacklogLock("/tmp/nonexistent-lock")).not.toThrow();
  });

  it("acquiring when already held returns false without stale break", async () => {
    const eexist = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    mockMkdirSync.mockImplementation(() => { throw eexist; });
    // Lock is fresh (held for only 1s)
    mockStatSync.mockReturnValue({ mtimeMs: Date.now() - 1_000 } as never);
    const result = await acquireBacklogLock("/tmp/test-lock", 2, 10);
    expect(result).toBe(false);
    // rmSync should NOT be called since lock is fresh
    expect(mockRmSync).not.toHaveBeenCalled();
  });

});
