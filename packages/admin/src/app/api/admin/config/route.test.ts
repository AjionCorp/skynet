import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs before importing the route — the handler uses fs for all file operations
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmdirSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

// Provide controlled config so tests don't depend on real .dev/ paths
vi.mock("../../../../lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test",
    workers: [],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX"],
  },
}));

import { GET, POST, dynamic } from "./route";
import { existsSync, readFileSync, mkdirSync } from "fs";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/admin/config route integration", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("" as never);
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

    it("returns empty entries when config file is missing", async () => {
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.entries).toEqual([]);
      expect(body.data.configPath).toBe("/tmp/test/.dev/skynet.config.sh");
    });

    it("returns parsed config entries from skynet.config.sh", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        [
          "#!/usr/bin/env bash",
          "# Max concurrent workers",
          'export SKYNET_MAX_WORKERS="4"',
          'export SKYNET_STALE_MINUTES="30"',
        ].join("\n") as never
      );

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.entries).toHaveLength(2);
      expect(body.data.entries[0]).toMatchObject({
        key: "SKYNET_MAX_WORKERS",
        value: "4",
        comment: "Max concurrent workers",
      });
      expect(body.data.entries[1]).toMatchObject({
        key: "SKYNET_STALE_MINUTES",
        value: "30",
      });
    });

    it("masks sensitive key values in response", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        [
          'export SKYNET_TG_BOT_TOKEN="secret-token"',
          'export SKYNET_MAX_WORKERS="4"',
        ].join("\n") as never
      );

      const res = await GET();
      const body = await res.json();

      const tokenEntry = body.data.entries.find(
        (e: { key: string }) => e.key === "SKYNET_TG_BOT_TOKEN"
      );
      const workersEntry = body.data.entries.find(
        (e: { key: string }) => e.key === "SKYNET_MAX_WORKERS"
      );
      expect(tokenEntry.value).toBe("••••••••");
      expect(workersEntry.value).toBe("4");
    });

    it("returns 500 with error envelope on read failure", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Permission denied");
    });
  });

  describe("POST", () => {
    it("returns 404 when config file is missing", async () => {
      const res = await POST(makeRequest({ updates: { SKYNET_MAX_WORKERS: "8" } }));
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toContain("Config file not found");
    });

    it("returns 400 for missing updates object", async () => {
      mockExistsSync.mockReturnValue(true);

      const res = await POST(makeRequest({}));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("Missing 'updates'");
    });

    it("returns 400 for shell injection attempt", async () => {
      mockExistsSync.mockReturnValue(true);

      const res = await POST(makeRequest({ updates: { SKYNET_MAX_WORKERS: "$(rm -rf /)" } }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("Unsafe characters");
    });

    it("returns 400 for non-mutable key", async () => {
      mockExistsSync.mockReturnValue(true);

      const res = await POST(makeRequest({ updates: { SKYNET_UNKNOWN_KEY: "value" } }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("not in the list of updatable");
    });

    it("updates config and returns updated entries on success", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('export SKYNET_MAX_WORKERS="4"\n' as never);

      const res = await POST(makeRequest({ updates: { SKYNET_MAX_WORKERS: "8" } }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.updatedKeys).toContain("SKYNET_MAX_WORKERS");
      expect(body.data.entries).toBeDefined();
      expect(body.data.configPath).toBe("/tmp/test/.dev/skynet.config.sh");
    });

    it("returns 400 for invalid JSON body", async () => {
      mockExistsSync.mockReturnValue(true);

      const res = await POST(
        new Request("http://localhost/api/admin/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-valid-json{{{",
        })
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.data).toBeNull();
    });

    it("returns 423 when config lock cannot be acquired", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('export SKYNET_MAX_WORKERS="4"\n' as never);
      mockMkdirSync.mockImplementation(() => {
        throw new Error("EEXIST");
      });

      const res = await POST(makeRequest({ updates: { SKYNET_MAX_WORKERS: "8" } }));
      const body = await res.json();

      expect(res.status).toBe(423);
      expect(body.error).toContain("locked");
      expect(body.data).toBeNull();
    });

    it("returns 400 for SKYNET_MAX_WORKERS out of range", async () => {
      mockExistsSync.mockReturnValue(true);

      const res = await POST(makeRequest({ updates: { SKYNET_MAX_WORKERS: "0" } }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("between 1 and 16");
    });
  });
});
