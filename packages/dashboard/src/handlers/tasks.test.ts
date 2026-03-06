import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTasksHandlers } from "./tasks";
import type { SkynetConfig } from "../types";
import { _resetRateLimits } from "../lib/rate-limiter";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
}));
vi.mock("../lib/db", () => ({
  getSkynetDB: vi.fn(() => ({
    countPending: vi.fn(() => { throw new Error("SQLite not available"); }),
    getBacklogItems: vi.fn(() => { throw new Error("SQLite not available"); }),
    addTask: vi.fn(),
    exportBacklog: vi.fn(() => { throw new Error("SQLite export not available"); }),
  })),
}));

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockRmSync = vi.mocked(rmSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return { projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-", workers: [], triggerableScripts: [], taskTags: ["FEAT", "FIX", "INFRA", "TEST", "NMI"], ...overrides };
}
function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const SAMPLE_BACKLOG = "# Backlog\n\n- [ ] [FEAT] Add login page\n- [>] [FIX] Fix auth bug\n- [ ] [FEAT] Add dashboard\n- [x] [FEAT] Setup project";

describe("createTasksHandlers", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    _resetRateLimits();
    vi.resetAllMocks();
    mockReadFileSync.mockReturnValue(SAMPLE_BACKLOG as never);
    mockWriteFileSync.mockReturnValue(undefined as never);
    mockMkdirSync.mockReturnValue(undefined as never);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    _resetRateLimits();
    vi.restoreAllMocks();
  });

  describe("GET", () => {
    it("returns backlog items excluding done items", async () => {
      const { GET } = createTasksHandlers(makeConfig());
      const res = await GET();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.items.filter((i: { status: string }) => i.status === "done")).toHaveLength(0);
      expect(body.data.pendingCount).toBe(2);
      expect(body.data.claimedCount).toBe(1);
      expect(body.data.manualDoneCount).toBe(1);
    });

    it("parses tags from backlog items", async () => {
      const { GET } = createTasksHandlers(makeConfig());
      const res = await GET();
      const { data } = await res.json();
      expect(data.items[0].tag).toBe("FEAT");
      expect(data.items[1].tag).toBe("FIX");
    });

    it("returns 500 on read failure", async () => {
      mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT: no such file"); });
      const { GET } = createTasksHandlers(makeConfig());
      const res = await GET();
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
    });
  });

  describe("POST", () => {
    it("inserts a task at top (default position)", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "New feature" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.inserted).toBe("- [ ] [FEAT] New feature");
      expect(body.data.position).toBe("top");
      // Find the backlog write (skip PID file write which is calls[0])
      const backlogCall = mockWriteFileSync.mock.calls.find(c => String(c[0]).endsWith(".tmp"));
      expect(backlogCall).toBeDefined();
      const written = backlogCall![1] as string;
      const lines = written.split("\n");
      expect(lines.findIndex((l) => l.includes("New feature"))).toBeLessThan(lines.findIndex((l) => l.includes("Add login page")));
    });

    it("inserts a task at bottom position", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FIX", title: "Fix thing", position: "bottom" }));
      const body = await res.json();
      expect(body.data.position).toBe("bottom");
    });

    it("returns 400 for invalid position value", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const req = makeRequest({ tag: "FEAT", title: "Bad position", position: "middle" });
      const res = await POST(req);
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("Invalid position");
    });

    it("includes description in task line when provided", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Add search", description: "Full-text search" }));
      const body = await res.json();
      expect(body.data.inserted).toContain("[FEAT] Add search");
      expect(body.data.inserted).toContain("Full-text search");
    });

    it("returns 400 for invalid tag", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "INVALID", title: "Something" }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("Invalid tag");
      expect(body.error).toContain("FEAT");
    });

    it("returns 400 for empty title", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "" }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Title is required");
    });

    it("returns 400 for whitespace-only title", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "   " }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("Title is required");
    });

    it("returns 423 when backlog is locked", async () => {
      mockMkdirSync.mockImplementation(() => { throw new Error("EEXIST"); });
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Locked test" }));
      expect(res.status).toBe(423);
    });

    it("releases lock in finally block even on write failure", async () => {
      // Only throw for backlog file writes, not PID file writes
      mockWriteFileSync.mockImplementation(((path: string) => {
        if (String(path).includes("/pid")) return undefined;
        throw new Error("Disk full");
      }) as typeof writeFileSync);
      const { POST } = createTasksHandlers(makeConfig());
      await POST(makeRequest({ tag: "FEAT", title: "Should release lock" }));
      expect(mockRmSync).toHaveBeenCalled();
    });

    it("acquires and releases lock via mkdir/rmSync", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      await POST(makeRequest({ tag: "FEAT", title: "Lock test" }));
      expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/skynet-test--backlog.lock");
      expect(mockRmSync).toHaveBeenCalledWith("/tmp/skynet-test--backlog.lock", { recursive: true, force: true });
    });

    it("trims title whitespace", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "  Spaced title  " }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.inserted).toBe("- [ ] [FEAT] Spaced title");
    });

    it("returns 200 with warning when file write fails but SQLite succeeds", async () => {
      // Only throw for backlog file writes, not PID file writes
      mockWriteFileSync.mockImplementation(((path: string) => {
        if (String(path).includes("/pid")) return undefined;
        throw new Error("Disk full");
      }) as typeof writeFileSync);
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Write fail" }));
      const body = await res.json();
      // Handler saves to SQLite first; if backlog.md export and file fallback both fail,
      // it returns 200 with a warning since the task is safely in SQLite.
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.inserted).toContain("Write fail");
      expect(body.data.warning).toContain("backlog.md sync failed");
    });

    it("returns 400 when tag field is missing", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ title: "No tag" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid tag");
    });

    it("trims description whitespace", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Desc test", description: "  some desc  " }));
      const body = await res.json();
      expect(body.data.inserted).toContain("— some desc");
    });

    it("omits description separator when description is whitespace-only", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "No desc", description: "   " }));
      const body = await res.json();
      expect(body.data.inserted).toBe("- [ ] [FEAT] No desc");
    });

    it("inserts task at header end when backlog has no existing tasks", async () => {
      mockReadFileSync.mockReturnValue("# Backlog\n\n" as never);
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "First task" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.inserted).toContain("First task");
      // Find the backlog write (skip PID file write)
      const backlogCall = mockWriteFileSync.mock.calls.find(c => String(c[0]).endsWith(".tmp"));
      expect(backlogCall).toBeDefined();
      const written = backlogCall![1] as string;
      expect(written).toContain("- [ ] [FEAT] First task");
    });
  });

  // -----------------------------------------------------------------------
  // P1-4: Title/description/newline validation tests
  // -----------------------------------------------------------------------
  describe("POST input validation", () => {
    it("returns 400 for title with newlines", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Title\nwith newline" }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("newlines");
    });

    it("returns 400 for title with carriage return", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Title\rwith CR" }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("newlines");
    });

    it("returns 400 for description with newlines", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Good title", description: "Bad\ndesc" }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("newlines");
    });

    it("returns 400 for blockedBy with newlines", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Good title", blockedBy: "Task\nA" }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("newlines");
    });

    it("returns 400 for title exceeding 500 characters", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const longTitle = "a".repeat(501);
      const res = await POST(makeRequest({ tag: "FEAT", title: longTitle }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("500 characters");
    });

    it("returns 400 for description exceeding 2000 characters", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const longDesc = "b".repeat(2001);
      const res = await POST(makeRequest({ tag: "FEAT", title: "Valid title", description: longDesc }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("2000");
    });

    it("returns 400 for very large descriptions (10001 chars)", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const hugeDesc = "x".repeat(10001);
      const res = await POST(makeRequest({ tag: "FEAT", title: "Valid title", description: hugeDesc }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("2000");
    });

    it("returns 400 for missing title field", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT" }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("Title is required");
    });

    it("returns 400 for null title", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: null }));
      const body = await res.json();
      expect(res.status).toBe(400);
    });

    it("allows title at exactly 500 characters", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const exactTitle = "a".repeat(500);
      const res = await POST(makeRequest({ tag: "FEAT", title: exactTitle }));
      expect(res.status).toBe(200);
    });

    it("allows description at exactly 2000 characters", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const exactDesc = "b".repeat(2000);
      const res = await POST(makeRequest({ tag: "FEAT", title: "Valid", description: exactDesc }));
      expect(res.status).toBe(200);
    });
  });

  describe("GET edge cases", () => {
    it("returns empty items when backlog has only done items", async () => {
      mockReadFileSync.mockReturnValue("# Backlog\n\n- [x] [FEAT] Done task\n- [x] [FIX] Also done" as never);
      const { GET } = createTasksHandlers(makeConfig());
      const res = await GET();
      const { data } = await res.json();
      expect(data.items).toHaveLength(0);
      expect(data.manualDoneCount).toBe(2);
    });

    it("returns empty items from empty backlog file", async () => {
      mockReadFileSync.mockReturnValue("# Backlog\n\n" as never);
      const { GET } = createTasksHandlers(makeConfig());
      const res = await GET();
      const { data } = await res.json();
      expect(data.items).toHaveLength(0);
      expect(data.pendingCount).toBe(0);
      expect(data.claimedCount).toBe(0);
      expect(data.manualDoneCount).toBe(0);
    });

    it("parses items without tags gracefully", async () => {
      mockReadFileSync.mockReturnValue("# Backlog\n\n- [ ] No tag here" as never);
      const { GET } = createTasksHandlers(makeConfig());
      const res = await GET();
      const { data } = await res.json();
      expect(data.items).toHaveLength(1);
      expect(data.items[0].tag).toBe("");
      expect(data.items[0].text).toBe("No tag here");
    });
  });

  describe("POST exportBacklog fallback", () => {
    it("falls back to direct file write when exportBacklog throws", async () => {
      // The default mock already has exportBacklog throwing.
      // Verify the task is inserted and backlog.md is written with correct position.
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Fallback test", position: "bottom" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.inserted).toContain("Fallback test");
      expect(body.data.position).toBe("bottom");
      // Verify a write was attempted (the fallback reads and re-writes backlog.md)
      const backlogWrite = mockWriteFileSync.mock.calls.find(c => String(c[0]).endsWith(".tmp"));
      expect(backlogWrite).toBeDefined();
      const written = backlogWrite![1] as string;
      expect(written).toContain("Fallback test");
    });

    it("returns 200 with warning when both exportBacklog and file fallback fail", async () => {
      // Make all file writes fail (except PID file writes)
      mockWriteFileSync.mockImplementation(((path: string) => {
        if (String(path).includes("/pid")) return undefined;
        throw new Error("Disk full");
      }) as typeof writeFileSync);
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Double fail" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.warning).toContain("backlog.md sync failed");
    });

    it("returns 200 with warning when exportBacklog throws and readFileSync also throws in fallback", async () => {
      // Simulate both exportBacklog (already throws via mock) AND readFileSync failing in fallback
      mockReadFileSync.mockImplementation(((path: string) => {
        if (String(path).endsWith("backlog.md")) throw new Error("Permission denied");
        return SAMPLE_BACKLOG;
      }) as typeof readFileSync);
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Read fail too" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.inserted).toContain("Read fail too");
      expect(body.data.warning).toContain("backlog.md sync failed");
    });
  });

  // -----------------------------------------------------------------------
  // TEST-P1-2: Concurrent write race test
  // -----------------------------------------------------------------------
  describe("POST concurrent writes", () => {
    it("handles 5 concurrent POST requests without errors or duplication", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const requests = Array.from({ length: 5 }, (_, i) =>
        POST(makeRequest({ tag: "FEAT", title: `Concurrent task ${i}` }))
      );
      const results = await Promise.all(requests);

      // All requests should succeed (200), get lock contention (423), or hit
      // in-memory rate limiting (429) depending on prior test timing/state;
      // but none should error (500).
      for (const res of results) {
        expect([200, 423, 429]).toContain(res.status);
      }

      // Count how many succeeded
      const successes = results.filter((r) => r.status === 200);

      // Verify no duplicated task titles in the written data
      const insertedTitles: string[] = [];
      for (const res of successes) {
        const body = await res.json();
        if (body.data?.inserted) {
          insertedTitles.push(body.data.inserted);
        }
      }
      const uniqueTitles = new Set(insertedTitles);
      expect(uniqueTitles.size).toBe(insertedTitles.length);
    });
  });

  // -----------------------------------------------------------------------
  // P1-3: Rate limiting tests
  // MUST be the last describe block — the in-memory _postTimestamps array
  // is module-level state and exhausting the limit pollutes later tests.
  // -----------------------------------------------------------------------
  describe("POST rate limiting", () => {
    beforeEach(() => {
      // Advance time past the 60s rate-limit window so any timestamps
      // accumulated by earlier tests are pruned on the next POST call.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 120_000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("allows requests within rate limit window", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Within limit" }));
      expect(res.status).toBe(200);
    });

    it("returns 429 when rate limit is exceeded (in-memory fallback)", async () => {
      // Advance time again to guarantee a clean slate for this test
      vi.setSystemTime(Date.now() + 120_000);
      // The DB mock throws, so in-memory rate limiting kicks in.
      // Max 30 per 60s. Send 31 requests — the 31st should be rate-limited.
      const { POST } = createTasksHandlers(makeConfig());
      let lastRes: Response | null = null;
      for (let i = 0; i < 31; i++) {
        lastRes = await POST(makeRequest({ tag: "FEAT", title: `Task ${i}` }));
      }
      expect(lastRes!.status).toBe(429);
      const body = await lastRes!.json();
      expect(body.error).toContain("Rate limit");
      expect(body.data).toBeNull();
    });
  });

  // ── TEST-P1-5: Concurrent POST verification ─────────────────────────
  describe("POST concurrent requests with unique titles", () => {
    beforeEach(() => {
      // Advance time well past the 60s rate-limit window so all accumulated
      // in-memory timestamps are pruned on the next POST call.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 300_000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("all 5 concurrent POSTs either succeed or get lock contention — no 500 errors", async () => {
      // Create a fresh handler instance so rate limit state starts clean
      const { POST } = createTasksHandlers(makeConfig());

      // Send a single warm-up request to trigger pruning of stale timestamps
      await POST(makeRequest({ tag: "FEAT", title: "Warmup task" }));

      const titles = ["Alpha task", "Beta task", "Gamma task", "Delta task", "Epsilon task"];
      const requests = titles.map(title =>
        POST(makeRequest({ tag: "FEAT", title }))
      );
      const results = await Promise.all(requests);

      // None should return 500. Acceptable: 200 (success), 423 (lock), 429 (rate limit)
      for (const res of results) {
        expect(res.status).not.toBe(500);
        expect([200, 423, 429]).toContain(res.status);
      }

      // Collect all successfully inserted titles
      const inserted: string[] = [];
      for (const res of results) {
        if (res.status === 200) {
          const body = await res.json();
          if (body.data?.inserted) {
            inserted.push(body.data.inserted);
          }
        }
      }

      // All inserted titles should be unique (no duplicates from race)
      const uniqueInserted = new Set(inserted);
      expect(uniqueInserted.size).toBe(inserted.length);

      // With fresh rate limit state and warm-up, at least one should succeed.
      // If all 5 got 423 (lock contention), that's also valid concurrency behavior.
      const successOrLock = results.filter(r => r.status === 200 || r.status === 423);
      expect(successOrLock.length).toBeGreaterThan(0);
    });
  });

});
