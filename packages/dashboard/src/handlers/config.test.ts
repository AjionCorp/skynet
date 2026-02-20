import { describe, it, expect, vi, beforeEach } from "vitest";
import { createConfigHandler } from "./config";
import type { SkynetConfig } from "../types";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockRenameSync = vi.mocked(renameSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
    workers: [],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX"],
    ...overrides,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createConfigHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("" as never);
  });

  describe("GET", () => {
    it("parses SKYNET_* export lines and returns key-value pairs", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        [
          '#!/usr/bin/env bash',
          '# Project config',
          'export SKYNET_MAX_WORKERS="4"',
          'export SKYNET_STALE_MINUTES="30"',
          'export SKYNET_PROJECT_NAME="my-project"',
        ].join("\n") as never
      );

      const { GET } = createConfigHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.entries).toHaveLength(3);
      expect(body.data.entries[0]).toMatchObject({ key: "SKYNET_MAX_WORKERS", value: "4" });
      expect(body.data.entries[1]).toMatchObject({ key: "SKYNET_STALE_MINUTES", value: "30" });
      expect(body.data.entries[2]).toMatchObject({ key: "SKYNET_PROJECT_NAME", value: "my-project" });
    });

    it("handles missing config file gracefully", async () => {
      mockExistsSync.mockReturnValue(false);

      const { GET } = createConfigHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.entries).toEqual([]);
      expect(body.data.configPath).toBe("/tmp/test/.dev/skynet.config.sh");
    });

    it("handles empty config file", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("" as never);

      const { GET } = createConfigHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.entries).toEqual([]);
    });

    it("strips surrounding quotes from values", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        [
          'export SKYNET_NAME="quoted-value"',
          "export SKYNET_OTHER='single-quoted'",
          "export SKYNET_BARE=bare-value",
        ].join("\n") as never
      );

      const { GET } = createConfigHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      expect(body.data.entries[0].value).toBe("quoted-value");
      expect(body.data.entries[1].value).toBe("single-quoted");
      expect(body.data.entries[2].value).toBe("bare-value");
    });

    it("preserves comment context for entries", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        [
          "# Max concurrent workers",
          'export SKYNET_MAX_WORKERS="4"',
        ].join("\n") as never
      );

      const { GET } = createConfigHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      expect(body.data.entries[0].comment).toBe("Max concurrent workers");
    });

    it("returns 500 with error envelope on read failure", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => { throw new Error("Permission denied"); });

      const { GET } = createConfigHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Permission denied");
    });
  });

  describe("POST", () => {
    it("validates SKYNET_MAX_WORKERS must be a positive integer", async () => {
      mockExistsSync.mockReturnValue(true);

      const { POST } = createConfigHandler(makeConfig());

      const res = await POST(makeRequest({ updates: { SKYNET_MAX_WORKERS: "0" } }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("SKYNET_MAX_WORKERS");
      expect(body.error).toContain("positive integer");
    });

    it("validates SKYNET_MAX_WORKERS rejects non-integer", async () => {
      mockExistsSync.mockReturnValue(true);

      const { POST } = createConfigHandler(makeConfig());

      const res = await POST(makeRequest({ updates: { SKYNET_MAX_WORKERS: "abc" } }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("SKYNET_MAX_WORKERS");
    });

    it("validates SKYNET_STALE_MINUTES must be >= 5", async () => {
      mockExistsSync.mockReturnValue(true);

      const { POST } = createConfigHandler(makeConfig());

      const res = await POST(makeRequest({ updates: { SKYNET_STALE_MINUTES: "3" } }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("SKYNET_STALE_MINUTES");
      expect(body.error).toContain(">= 5");
    });

    it("accepts valid SKYNET_MAX_WORKERS value", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('export SKYNET_MAX_WORKERS="4"\n' as never);

      const { POST } = createConfigHandler(makeConfig());
      const res = await POST(makeRequest({ updates: { SKYNET_MAX_WORKERS: "8" } }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
    });

    it("accepts valid SKYNET_STALE_MINUTES value", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('export SKYNET_STALE_MINUTES="30"\n' as never);

      const { POST } = createConfigHandler(makeConfig());
      const res = await POST(makeRequest({ updates: { SKYNET_STALE_MINUTES: "5" } }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
    });

    it("rejects invalid values with descriptive error", async () => {
      mockExistsSync.mockReturnValue(true);

      const { POST } = createConfigHandler(makeConfig());

      // Shell injection
      const res1 = await POST(makeRequest({ updates: { SKYNET_FOO: "val$(rm -rf /)" } }));
      const body1 = await res1.json();
      expect(res1.status).toBe(400);
      expect(body1.error).toContain("Unsafe characters");

      // Backtick injection
      const res2 = await POST(makeRequest({ updates: { SKYNET_FOO: "`whoami`" } }));
      const body2 = await res2.json();
      expect(res2.status).toBe(400);
      expect(body2.error).toContain("Unsafe characters");

      // Invalid key name
      const res3 = await POST(makeRequest({ updates: { "invalid-key": "value" } }));
      const body3 = await res3.json();
      expect(res3.status).toBe(400);
      expect(body3.error).toContain("Invalid config key");
    });

    it("performs atomic write via .tmp then rename", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('export SKYNET_MAX_WORKERS="4"\n' as never);

      const { POST } = createConfigHandler(makeConfig());
      await POST(makeRequest({ updates: { SKYNET_MAX_WORKERS: "8" } }));

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/skynet.config.sh.tmp",
        expect.any(String),
        "utf-8"
      );
      expect(mockRenameSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/skynet.config.sh.tmp",
        "/tmp/test/.dev/skynet.config.sh"
      );
    });

    it("returns 404 when config file is missing", async () => {
      mockExistsSync.mockReturnValue(false);

      const { POST } = createConfigHandler(makeConfig());
      const res = await POST(makeRequest({ updates: { SKYNET_FOO: "bar" } }));
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toContain("Config file not found");
    });

    it("returns 400 when updates object is missing", async () => {
      mockExistsSync.mockReturnValue(true);

      const { POST } = createConfigHandler(makeConfig());
      const res = await POST(makeRequest({}));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("Missing 'updates'");
    });

    it("returns updated entries after successful write", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('export SKYNET_MAX_WORKERS="8"\n' as never);

      const { POST } = createConfigHandler(makeConfig());
      const res = await POST(makeRequest({ updates: { SKYNET_MAX_WORKERS: "8" } }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.entries).toBeDefined();
      expect(body.data.updatedKeys).toContain("SKYNET_MAX_WORKERS");
    });

    it("returns 500 with error envelope on write failure", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('export SKYNET_FOO="bar"\n' as never);
      mockWriteFileSync.mockImplementation(() => { throw new Error("Disk full"); });

      const { POST } = createConfigHandler(makeConfig());
      const res = await POST(makeRequest({ updates: { SKYNET_FOO: "baz" } }));
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Disk full");
    });

    it("rejects SKYNET_MAX_WORKERS with negative value", async () => {
      mockExistsSync.mockReturnValue(true);

      const { POST } = createConfigHandler(makeConfig());
      const res = await POST(makeRequest({ updates: { SKYNET_MAX_WORKERS: "-1" } }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("SKYNET_MAX_WORKERS");
    });

    it("rejects semicolon injection in values", async () => {
      mockExistsSync.mockReturnValue(true);

      const { POST } = createConfigHandler(makeConfig());
      const res = await POST(makeRequest({ updates: { SKYNET_FOO: "val;rm -rf /" } }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("Unsafe characters");
    });
  });
});
