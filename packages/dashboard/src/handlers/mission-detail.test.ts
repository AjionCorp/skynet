import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMissionDetailHandler } from "./mission-detail";
import type { SkynetConfig } from "../types";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockUnlinkSync = vi.mocked(unlinkSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX"],
    ...overrides,
  };
}

const BASE_URL = "http://localhost/api/admin/missions";

function makeGetRequest(slug: string): Request {
  return new Request(`${BASE_URL}/${slug}`, { method: "GET" });
}

function makePutRequest(slug: string, body: Record<string, unknown>): Request {
  return new Request(`${BASE_URL}/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(slug: string): Request {
  return new Request(`${BASE_URL}/${slug}`, { method: "DELETE" });
}

/** Simulate _config.json existing with given content */
function mockConfigFile(config: Record<string, unknown>): void {
  mockExistsSync.mockImplementation((p) => {
    if (String(p).endsWith("_config.json")) return true;
    return false;
  });
  mockReadFileSync.mockImplementation((p) => {
    if (String(p).endsWith("_config.json")) return JSON.stringify(config);
    return "";
  });
}

/** Simulate both mission file and _config.json existing */
function mockMissionAndConfig(
  slug: string,
  missionContent: string,
  config: Record<string, unknown>,
): void {
  mockExistsSync.mockImplementation((p) => {
    const path = String(p);
    if (path.endsWith(`${slug}.md`)) return true;
    if (path.endsWith("_config.json")) return true;
    return false;
  });
  mockReadFileSync.mockImplementation((p) => {
    const path = String(p);
    if (path.endsWith(`${slug}.md`)) return missionContent;
    if (path.endsWith("_config.json")) return JSON.stringify(config);
    return "";
  });
}

describe("createMissionDetailHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── GET ──────────────────────────────────────────────────────────

  describe("GET", () => {
    it("returns 400 when slug is missing (URL ends with /missions)", async () => {
      const handler = createMissionDetailHandler(makeConfig());
      const req = new Request(`${BASE_URL}`, { method: "GET" });
      const res = await handler.GET(req);
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing or invalid slug");
      expect(body.data).toBeNull();
    });

    it("returns 400 when slug contains invalid characters", async () => {
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.GET(makeGetRequest("bad_slug!@#"));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing or invalid slug");
    });

    it("returns 404 when mission file does not exist", async () => {
      mockExistsSync.mockReturnValue(false);
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.GET(makeGetRequest("nonexistent"));
      const body = await res.json();
      expect(res.status).toBe(404);
      expect(body.error).toBe("Mission 'nonexistent' not found");
    });

    it("returns mission data on success", async () => {
      const missionContent = "# My Mission\n\n## Purpose\nTest mission";
      mockMissionAndConfig("my-mission", missionContent, {
        activeMission: "my-mission",
        assignments: { "dev-worker-1": "my-mission" },
      });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.GET(makeGetRequest("my-mission"));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.slug).toBe("my-mission");
      expect(body.data.raw).toBe(missionContent);
      expect(body.data.isActive).toBe(true);
      expect(body.data.assignedWorkers).toEqual(["dev-worker-1"]);
    });

    it("returns isActive false when mission is not the active one", async () => {
      mockMissionAndConfig("other-mission", "content", {
        activeMission: "main",
        assignments: {},
      });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.GET(makeGetRequest("other-mission"));
      const { data } = await res.json();
      expect(data.isActive).toBe(false);
    });

    it("returns empty assignedWorkers when no workers are assigned", async () => {
      mockMissionAndConfig("solo", "content", {
        activeMission: "main",
        assignments: { "dev-worker-1": "different-mission" },
      });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.GET(makeGetRequest("solo"));
      const { data } = await res.json();
      expect(data.assignedWorkers).toEqual([]);
    });

    it("returns default llmConfig when none is configured", async () => {
      mockMissionAndConfig("no-llm", "content", {
        activeMission: "main",
        assignments: {},
      });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.GET(makeGetRequest("no-llm"));
      const { data } = await res.json();
      expect(data.llmConfig).toEqual({ provider: "auto" });
    });

    it("returns configured llmConfig when present", async () => {
      mockMissionAndConfig("with-llm", "content", {
        activeMission: "main",
        assignments: {},
        llmConfigs: { "with-llm": { provider: "openai", model: "gpt-4" } },
      });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.GET(makeGetRequest("with-llm"));
      const { data } = await res.json();
      expect(data.llmConfig).toEqual({ provider: "openai", model: "gpt-4" });
    });

    it("returns defaults when _config.json does not exist", async () => {
      // Mission file exists, but _config.json does not
      mockExistsSync.mockImplementation((p) => {
        if (String(p).endsWith("defaults.md")) return true;
        return false;
      });
      mockReadFileSync.mockImplementation((p) => {
        if (String(p).endsWith("defaults.md")) return "# Default Mission";
        throw new Error("ENOENT");
      });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.GET(makeGetRequest("defaults"));
      const { data } = await res.json();
      expect(res.status).toBe(200);
      expect(data.isActive).toBe(false);
      expect(data.assignedWorkers).toEqual([]);
    });

    it("returns 500 when readFileSync throws", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => { throw new Error("Permission denied"); });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.GET(makeGetRequest("broken"));
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Permission denied");
    });

    it("returns generic error when non-Error is thrown", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => { throw "unexpected"; });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.GET(makeGetRequest("broken"));
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.error).toBe("Failed to read mission");
    });

    it("accepts uppercase letters in slug", async () => {
      mockMissionAndConfig("MyMission", "content", {
        activeMission: "main",
        assignments: {},
      });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.GET(makeGetRequest("MyMission"));
      const { data } = await res.json();
      expect(data.slug).toBe("MyMission");
    });
  });

  // ── PUT ──────────────────────────────────────────────────────────

  describe("PUT", () => {
    it("returns 400 when slug is invalid", async () => {
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.PUT(makePutRequest("bad slug!", { raw: "content" }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing or invalid slug");
    });

    it("returns 404 when mission file does not exist", async () => {
      mockExistsSync.mockReturnValue(false);
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.PUT(makePutRequest("nonexistent", { raw: "content" }));
      const body = await res.json();
      expect(res.status).toBe(404);
      expect(body.error).toBe("Mission 'nonexistent' not found");
    });

    it("returns 400 when body is invalid JSON", async () => {
      mockExistsSync.mockReturnValue(true);
      const handler = createMissionDetailHandler(makeConfig());
      const req = new Request(`${BASE_URL}/valid-slug`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const res = await handler.PUT(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 when raw field is missing", async () => {
      mockExistsSync.mockReturnValue(true);
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.PUT(makePutRequest("my-mission", { content: "wrong field" }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing 'raw' field (string)");
    });

    it("returns 400 when raw field is not a string", async () => {
      mockExistsSync.mockReturnValue(true);
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.PUT(makePutRequest("my-mission", { raw: 42 }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing 'raw' field (string)");
    });

    it("writes content and returns success on valid PUT", async () => {
      mockExistsSync.mockReturnValue(true);
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.PUT(makePutRequest("my-mission", { raw: "# Updated Content" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.slug).toBe("my-mission");
      expect(body.data.saved).toBe(true);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining("my-mission.md"),
        "# Updated Content",
        "utf-8",
      );
    });

    it("returns 500 when writeFileSync throws", async () => {
      mockExistsSync.mockReturnValue(true);
      mockWriteFileSync.mockImplementation(() => { throw new Error("Disk full"); });
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.PUT(makePutRequest("my-mission", { raw: "content" }));
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Disk full");
    });

    it("returns generic error when non-Error is thrown", async () => {
      mockExistsSync.mockReturnValue(true);
      mockWriteFileSync.mockImplementation(() => { throw 123; });
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.PUT(makePutRequest("my-mission", { raw: "content" }));
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.error).toBe("Failed to update mission");
    });
  });

  // ── DELETE ───────────────────────────────────────────────────────

  describe("DELETE", () => {
    it("returns 400 when slug is invalid", async () => {
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.DELETE(makeDeleteRequest("bad_slug!"));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing or invalid slug");
    });

    it("returns 409 when trying to delete the active mission", async () => {
      mockConfigFile({ activeMission: "current", assignments: {} });
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.DELETE(makeDeleteRequest("current"));
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toContain("Cannot delete the active mission");
    });

    it("returns 404 when mission file does not exist", async () => {
      mockConfigFile({ activeMission: "main", assignments: {} });
      // Mission file does not exist (only _config.json does)
      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.DELETE(makeDeleteRequest("nonexistent"));
      const body = await res.json();
      expect(res.status).toBe(404);
      expect(body.error).toBe("Mission 'nonexistent' not found");
    });

    it("deletes mission file and returns success", async () => {
      mockMissionAndConfig("old-mission", "content", {
        activeMission: "main",
        assignments: {},
      });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.DELETE(makeDeleteRequest("old-mission"));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.slug).toBe("old-mission");
      expect(body.data.deleted).toBe(true);
      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining("old-mission.md"),
      );
    });

    it("clears worker assignments for the deleted mission", async () => {
      mockMissionAndConfig("removable", "content", {
        activeMission: "main",
        assignments: { "dev-worker-1": "removable", "dev-worker-2": "other" },
      });

      const handler = createMissionDetailHandler(makeConfig());
      await handler.DELETE(makeDeleteRequest("removable"));

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const writtenConfig = JSON.parse(
        mockWriteFileSync.mock.calls[0][1] as string,
      );
      expect(writtenConfig.assignments["dev-worker-1"]).toBeNull();
      expect(writtenConfig.assignments["dev-worker-2"]).toBe("other");
    });

    it("clears llmConfig for the deleted mission", async () => {
      mockMissionAndConfig("removable", "content", {
        activeMission: "main",
        assignments: {},
        llmConfigs: { removable: { provider: "openai" }, other: { provider: "anthropic" } },
      });

      const handler = createMissionDetailHandler(makeConfig());
      await handler.DELETE(makeDeleteRequest("removable"));

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const writtenConfig = JSON.parse(
        mockWriteFileSync.mock.calls[0][1] as string,
      );
      expect(writtenConfig.llmConfigs.removable).toBeUndefined();
      expect(writtenConfig.llmConfigs.other).toEqual({ provider: "anthropic" });
    });

    it("does not write config when no assignments or llmConfig to clean", async () => {
      mockMissionAndConfig("clean", "content", {
        activeMission: "main",
        assignments: { "dev-worker-1": "other" },
      });

      const handler = createMissionDetailHandler(makeConfig());
      await handler.DELETE(makeDeleteRequest("clean"));

      // Only unlinkSync should be called, not writeFileSync
      expect(mockUnlinkSync).toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("returns 500 when unlinkSync throws", async () => {
      mockMissionAndConfig("failing", "content", {
        activeMission: "main",
        assignments: {},
      });
      mockUnlinkSync.mockImplementation(() => { throw new Error("EPERM"); });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.DELETE(makeDeleteRequest("failing"));
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("EPERM");
    });

    it("returns generic error when non-Error is thrown", async () => {
      mockMissionAndConfig("failing", "content", {
        activeMission: "main",
        assignments: {},
      });
      mockUnlinkSync.mockImplementation(() => { throw null; });

      const handler = createMissionDetailHandler(makeConfig());
      const res = await handler.DELETE(makeDeleteRequest("failing"));
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.error).toBe("Failed to delete mission");
    });
  });
});
