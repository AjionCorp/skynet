import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMissionRawHandler } from "./mission-raw";
import type { SkynetConfig } from "../types";

vi.mock("../lib/file-reader", () => ({
  readDevFile: vi.fn(() => ""),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
}));

import { readDevFile } from "../lib/file-reader";
import { existsSync, writeFileSync } from "fs";

const mockReadDevFile = vi.mocked(readDevFile);
const mockExistsSync = vi.mocked(existsSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: [], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

describe("createMissionRawHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET", () => {
    it("returns { data, error: null } envelope on success", async () => {
      const handler = createMissionRawHandler(makeConfig());
      const res = await handler.GET();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data).toBeDefined();
    });

    it("returns raw mission.md content in data.raw", async () => {
      const missionContent = "## Purpose\n\nBuild the best pipeline.\n\n## Goals\n\n1. Ship it\n";
      mockReadDevFile.mockReturnValue(missionContent);
      const handler = createMissionRawHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.raw).toBe(missionContent);
    });

    it("reads from the correct file (mission.md)", async () => {
      const handler = createMissionRawHandler(makeConfig({ devDir: "/custom/.dev" }));
      await handler.GET();
      expect(mockReadDevFile).toHaveBeenCalledWith("/custom/.dev", "mission.md");
    });

    it("returns empty string in data.raw when mission.md is empty", async () => {
      mockReadDevFile.mockReturnValue("");
      const handler = createMissionRawHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.raw).toBe("");
    });

    it("response shape has only raw key in data", async () => {
      mockReadDevFile.mockReturnValue("some content");
      const handler = createMissionRawHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(Object.keys(data)).toEqual(["raw"]);
    });

    it("returns 500 with generic error in production when readDevFile throws", async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      mockReadDevFile.mockImplementation(() => { throw new Error("ENOENT: no such file or directory"); });
      const handler = createMissionRawHandler(makeConfig());
      const res = await handler.GET();
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Failed to read mission.md");
      process.env.NODE_ENV = origEnv;
    });

    it("returns 500 with detailed error in development when readDevFile throws", async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      mockReadDevFile.mockImplementation(() => { throw new Error("ENOENT: no such file or directory"); });
      const handler = createMissionRawHandler(makeConfig());
      const res = await handler.GET();
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("ENOENT: no such file or directory");
      process.env.NODE_ENV = origEnv;
    });

    it("returns generic error message when non-Error is thrown", async () => {
      mockReadDevFile.mockImplementation(() => { throw "unexpected"; });
      const handler = createMissionRawHandler(makeConfig());
      const res = await handler.GET();
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Failed to read mission.md");
    });
  });

  describe("PUT", () => {
    it("writes raw content to mission.md", async () => {
      const handler = createMissionRawHandler(makeConfig());
      const req = new Request("http://localhost/mission/raw", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: "# New Mission\n\n## Purpose\nTest" }),
      });
      const res = await handler.PUT(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.saved).toBe(true);
      expect(body.error).toBeNull();
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/mission.md",
        "# New Mission\n\n## Purpose\nTest",
        "utf-8",
      );
    });

    it("returns 400 when raw field is missing", async () => {
      const handler = createMissionRawHandler(makeConfig());
      const req = new Request("http://localhost/mission/raw", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "wrong field" }),
      });
      const res = await handler.PUT(req);
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing 'raw' field (string)");
    });

    it("returns 400 when body is invalid JSON", async () => {
      const handler = createMissionRawHandler(makeConfig());
      const req = new Request("http://localhost/mission/raw", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const res = await handler.PUT(req);
      expect(res.status).toBe(400);
    });

    it("returns 500 when writeFileSync throws", async () => {
      mockWriteFileSync.mockImplementation(() => { throw new Error("Permission denied"); });
      const handler = createMissionRawHandler(makeConfig());
      const req = new Request("http://localhost/mission/raw", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: "test" }),
      });
      const res = await handler.PUT(req);
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.error).toBe("Permission denied");
    });
  });
});
