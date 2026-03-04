import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs before importing the route — the handler uses fs for file-based backlog operations
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

// Provide controlled config so tests don't depend on real .dev/ paths
vi.mock("../../../../lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test",
    workers: [],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX", "INFRA", "TEST", "NMI"],
  },
}));

import { GET, POST, dynamic } from "./route";
import { readFileSync, mkdirSync, existsSync } from "fs";

const mockReadFileSync = vi.mocked(readFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockExistsSync = vi.mocked(existsSync);

const SAMPLE_BACKLOG =
  "# Backlog\n\n- [ ] [FEAT] Add login page\n- [>] [FIX] Fix auth bug\n- [ ] [FEAT] Add dashboard\n- [x] [FEAT] Setup project";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/admin/tasks route integration", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.clearAllMocks();
    mockReadFileSync.mockReturnValue(SAMPLE_BACKLOG as never);
    mockMkdirSync.mockReturnValue(undefined as never);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("exports force-dynamic to disable Next.js response caching", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  describe("GET", () => {
    it("returns { data, error } response envelope on success", async () => {
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("error");
      expect(body.error).toBeNull();
    });

    it("returns backlog items excluding done items", async () => {
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      const doneItems = body.data.items.filter(
        (i: { status: string }) => i.status === "done"
      );
      expect(doneItems).toHaveLength(0);
      expect(body.data.pendingCount).toBe(2);
      expect(body.data.claimedCount).toBe(1);
      expect(body.data.manualDoneCount).toBe(1);
    });

    it("returns items with tag and status fields", async () => {
      const res = await GET();
      const { data } = await res.json();

      expect(data.items[0]).toMatchObject({ tag: "FEAT", status: "pending" });
      expect(data.items[1]).toMatchObject({ tag: "FIX", status: "claimed" });
    });

    it("returns 500 when backlog file is unreadable", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file");
      });

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
    });

    it("returns empty items for empty backlog", async () => {
      mockReadFileSync.mockReturnValue("# Backlog\n\n" as never);

      const res = await GET();
      const { data } = await res.json();

      expect(data.items).toHaveLength(0);
      expect(data.pendingCount).toBe(0);
      expect(data.claimedCount).toBe(0);
    });

    it("supports optional Request parameter for mission slug", async () => {
      const req = new Request("http://localhost/api/admin/tasks?slug=my-mission");
      const res = await GET(req);
      const body = await res.json();

      // Should still work (falls back to file-based without SQLite)
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
    });
  });

  describe("POST — validation", () => {
    it("returns 400 for invalid tag", async () => {
      const res = await POST(makeRequest({ tag: "INVALID", title: "Something" }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("Invalid tag");
      expect(body.error).toContain("FEAT");
    });

    it("returns 400 for missing tag field", async () => {
      const res = await POST(makeRequest({ title: "No tag" }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("Invalid tag");
    });

    it("returns 400 for empty title", async () => {
      const res = await POST(makeRequest({ tag: "FEAT", title: "" }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("Title is required");
    });

    it("returns 400 for whitespace-only title", async () => {
      const res = await POST(makeRequest({ tag: "FEAT", title: "   " }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("Title is required");
    });

    it("returns 400 for title exceeding 500 characters", async () => {
      const res = await POST(makeRequest({ tag: "FEAT", title: "a".repeat(501) }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("500 characters");
    });

    it("returns 400 for title containing newlines", async () => {
      const res = await POST(
        makeRequest({ tag: "FEAT", title: "Title\nwith newline" })
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("newlines");
    });

    it("returns 400 for description exceeding 2000 characters", async () => {
      const res = await POST(
        makeRequest({
          tag: "FEAT",
          title: "Valid title",
          description: "b".repeat(2001),
        })
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("2000");
    });

    it("returns 400 for description containing newlines", async () => {
      const res = await POST(
        makeRequest({
          tag: "FEAT",
          title: "Valid title",
          description: "Bad\ndesc",
        })
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("newlines");
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await POST(
        new Request("http://localhost/api/admin/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-valid-json",
        })
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.data).toBeNull();
    });
  });

  describe("POST — lock contention", () => {
    it("returns 423 when backlog lock cannot be acquired", async () => {
      mockMkdirSync.mockImplementation(() => {
        throw new Error("EEXIST");
      });
      mockExistsSync.mockReturnValue(false);

      const res = await POST(makeRequest({ tag: "FEAT", title: "Locked test" }));
      const body = await res.json();

      expect(res.status).toBe(423);
      expect(body.error).toContain("locked");
      expect(body.data).toBeNull();
    });
  });
});
