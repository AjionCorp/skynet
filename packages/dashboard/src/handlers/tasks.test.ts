import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTasksHandlers } from "./tasks";
import type { SkynetConfig } from "../types";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmdirSync: vi.fn(),
}));

import { readFileSync, writeFileSync, mkdirSync, rmdirSync } from "fs";
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockRmdirSync = vi.mocked(rmdirSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return { projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-", workers: [], triggerableScripts: [], taskTags: ["FEAT", "FIX", "INFRA", "TEST"], ...overrides };
}
function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const SAMPLE_BACKLOG = "# Backlog\n\n- [ ] [FEAT] Add login page\n- [>] [FIX] Fix auth bug\n- [ ] [FEAT] Add dashboard\n- [x] [FEAT] Setup project";

describe("createTasksHandlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReadFileSync.mockReturnValue(SAMPLE_BACKLOG as never);
    mockWriteFileSync.mockReturnValue(undefined as never);
    mockMkdirSync.mockReturnValue(undefined as never);
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
      expect(body.data.doneCount).toBe(1);
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
      const written = mockWriteFileSync.mock.calls[0][1] as string;
      const lines = written.split("\n");
      expect(lines.findIndex((l) => l.includes("New feature"))).toBeLessThan(lines.findIndex((l) => l.includes("Add login page")));
    });

    it("inserts a task at bottom position", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FIX", title: "Fix thing", position: "bottom" }));
      const body = await res.json();
      expect(body.data.position).toBe("bottom");
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
      expect(res.status).toBe(400);
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
      expect(res.status).toBe(400);
    });

    it("returns 423 when backlog is locked", async () => {
      mockMkdirSync.mockImplementation(() => { throw new Error("EEXIST"); });
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Locked test" }));
      expect(res.status).toBe(423);
    });

    it("releases lock in finally block even on write failure", async () => {
      mockWriteFileSync.mockImplementation(() => { throw new Error("Disk full"); });
      const { POST } = createTasksHandlers(makeConfig());
      await POST(makeRequest({ tag: "FEAT", title: "Should release lock" }));
      expect(mockRmdirSync).toHaveBeenCalled();
    });

    it("acquires and releases lock via mkdir/rmdir", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      await POST(makeRequest({ tag: "FEAT", title: "Lock test" }));
      expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/skynet-test-backlog.lock");
      expect(mockRmdirSync).toHaveBeenCalledWith("/tmp/skynet-test-backlog.lock");
    });

    it("trims title whitespace", async () => {
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "  Spaced title  " }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.inserted).toBe("- [ ] [FEAT] Spaced title");
    });

    it("returns 500 with error message on write failure", async () => {
      mockWriteFileSync.mockImplementation(() => { throw new Error("Disk full"); });
      const { POST } = createTasksHandlers(makeConfig());
      const res = await POST(makeRequest({ tag: "FEAT", title: "Write fail" }));
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Disk full");
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
      const written = mockWriteFileSync.mock.calls[0][1] as string;
      expect(written).toContain("- [ ] [FEAT] First task");
    });
  });

  describe("GET edge cases", () => {
    it("returns empty items when backlog has only done items", async () => {
      mockReadFileSync.mockReturnValue("# Backlog\n\n- [x] [FEAT] Done task\n- [x] [FIX] Also done" as never);
      const { GET } = createTasksHandlers(makeConfig());
      const res = await GET();
      const { data } = await res.json();
      expect(data.items).toHaveLength(0);
      expect(data.doneCount).toBe(2);
    });

    it("returns empty items from empty backlog file", async () => {
      mockReadFileSync.mockReturnValue("# Backlog\n\n" as never);
      const { GET } = createTasksHandlers(makeConfig());
      const res = await GET();
      const { data } = await res.json();
      expect(data.items).toHaveLength(0);
      expect(data.pendingCount).toBe(0);
      expect(data.claimedCount).toBe(0);
      expect(data.doneCount).toBe(0);
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
});
