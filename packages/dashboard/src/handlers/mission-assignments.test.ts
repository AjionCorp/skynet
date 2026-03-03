import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMissionAssignmentsHandler } from "./mission-assignments";
import type { SkynetConfig } from "../types";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from "fs";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
    workers: [],
    triggerableScripts: [],
    taskTags: [],
    ...overrides,
  };
}

function makePutRequest(body: unknown): Request {
  return new Request("http://localhost/api/mission/assignments", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createMissionAssignmentsHandler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("");
    mockWriteFileSync.mockImplementation(() => {});
  });

  describe("GET", () => {
    it("returns { data, error: null } envelope on success", async () => {
      const handler = createMissionAssignmentsHandler(makeConfig());
      const res = await handler.GET();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data).toBeDefined();
    });

    it("returns default config when _config.json does not exist", async () => {
      mockExistsSync.mockReturnValue(false);
      const handler = createMissionAssignmentsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.activeMission).toBe("main");
      expect(data.assignments).toEqual({});
    });

    it("returns parsed config when _config.json exists", async () => {
      const savedConfig = {
        activeMission: "feature-x",
        assignments: { "dev-worker-1": "feature-x" },
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(savedConfig));
      const handler = createMissionAssignmentsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.activeMission).toBe("feature-x");
      expect(data.assignments).toEqual({ "dev-worker-1": "feature-x" });
    });

    it("returns default config when _config.json contains invalid JSON", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not valid json {{{");
      const handler = createMissionAssignmentsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.activeMission).toBe("main");
      expect(data.assignments).toEqual({});
    });

    it("reads from correct path based on devDir", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ activeMission: "main", assignments: {} }));
      const handler = createMissionAssignmentsHandler(makeConfig({ devDir: "/custom/.dev" }));
      await handler.GET();
      expect(mockExistsSync).toHaveBeenCalledWith("/custom/.dev/missions/_config.json");
    });
  });

  describe("PUT", () => {
    describe("activeMission updates", () => {
      it("updates activeMission when mission file exists", async () => {
        mockExistsSync.mockImplementation((p) => {
          if (String(p).endsWith("feature-y.md")) return true;
          return false;
        });
        mockReadFileSync.mockReturnValue("# Feature Y mission content");
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({ activeMission: "feature-y" }));
        const { data } = await res.json();
        expect(res.status).toBe(200);
        expect(data.activeMission).toBe("feature-y");
      });

      it("copies mission content to legacy mission.md", async () => {
        mockExistsSync.mockImplementation((p) => {
          if (String(p).endsWith("feature-y.md")) return true;
          return false;
        });
        mockReadFileSync.mockReturnValue("# Feature Y content");
        const handler = createMissionAssignmentsHandler(makeConfig());
        await handler.PUT(makePutRequest({ activeMission: "feature-y" }));
        expect(mockWriteFileSync).toHaveBeenCalledWith(
          "/tmp/test/.dev/mission.md",
          "# Feature Y content",
          "utf-8",
        );
      });

      it("returns 404 when activeMission file does not exist", async () => {
        mockExistsSync.mockReturnValue(false);
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({ activeMission: "nonexistent" }));
        const body = await res.json();
        expect(res.status).toBe(404);
        expect(body.error).toBe("Mission 'nonexistent' not found");
        expect(body.data).toBeNull();
      });
    });

    describe("worker assignments", () => {
      it("assigns a worker to a mission when mission file exists", async () => {
        mockExistsSync.mockImplementation((p) => {
          if (String(p).endsWith("feature-x.md")) return true;
          return false;
        });
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({
          assignments: { "dev-worker-1": "feature-x" },
        }));
        const { data } = await res.json();
        expect(res.status).toBe(200);
        expect(data.assignments["dev-worker-1"]).toBe("feature-x");
      });

      it("allows assigning null (unassign a worker)", async () => {
        mockExistsSync.mockReturnValue(false);
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({
          assignments: { "dev-worker-1": null },
        }));
        const { data } = await res.json();
        expect(res.status).toBe(200);
        expect(data.assignments["dev-worker-1"]).toBeNull();
      });

      it("returns 404 when assigned mission file does not exist", async () => {
        mockExistsSync.mockReturnValue(false);
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({
          assignments: { "dev-worker-1": "missing-mission" },
        }));
        const body = await res.json();
        expect(res.status).toBe(404);
        expect(body.error).toBe("Mission 'missing-mission' not found for worker 'dev-worker-1'");
      });

      it("handles multiple worker assignments", async () => {
        mockExistsSync.mockImplementation((p) => {
          const s = String(p);
          return s.endsWith("mission-a.md") || s.endsWith("mission-b.md");
        });
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({
          assignments: {
            "dev-worker-1": "mission-a",
            "dev-worker-2": "mission-b",
          },
        }));
        const { data } = await res.json();
        expect(res.status).toBe(200);
        expect(data.assignments["dev-worker-1"]).toBe("mission-a");
        expect(data.assignments["dev-worker-2"]).toBe("mission-b");
      });
    });

    describe("llmConfigs updates", () => {
      it("sets llmConfig for a mission when mission file exists", async () => {
        mockExistsSync.mockImplementation((p) => {
          if (String(p).endsWith("feature-z.md")) return true;
          return false;
        });
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({
          llmConfigs: { "feature-z": { provider: "claude", model: "opus" } },
        }));
        const { data } = await res.json();
        expect(res.status).toBe(200);
        expect(data.llmConfigs["feature-z"]).toEqual({ provider: "claude", model: "opus" });
      });

      it("returns 404 when llmConfig mission file does not exist", async () => {
        mockExistsSync.mockReturnValue(false);
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({
          llmConfigs: { "ghost-mission": { provider: "gemini" } },
        }));
        const body = await res.json();
        expect(res.status).toBe(404);
        expect(body.error).toBe("Mission 'ghost-mission' not found for llmConfig");
      });

      it("initializes llmConfigs object if not present in existing config", async () => {
        // Existing config without llmConfigs
        mockExistsSync.mockImplementation((p) => {
          const s = String(p);
          if (s.endsWith("_config.json")) return true;
          if (s.endsWith("main.md")) return true;
          return false;
        });
        mockReadFileSync.mockReturnValue(
          JSON.stringify({ activeMission: "main", assignments: {} }),
        );
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({
          llmConfigs: { main: { provider: "codex" } },
        }));
        const { data } = await res.json();
        expect(res.status).toBe(200);
        expect(data.llmConfigs).toBeDefined();
        expect(data.llmConfigs.main).toEqual({ provider: "codex" });
      });
    });

    describe("combined updates", () => {
      it("updates activeMission, assignments, and llmConfigs together", async () => {
        mockExistsSync.mockImplementation((p) => {
          const s = String(p);
          return s.endsWith("sprint-1.md");
        });
        mockReadFileSync.mockReturnValue("# Sprint 1");
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({
          activeMission: "sprint-1",
          assignments: { "dev-worker-1": "sprint-1" },
          llmConfigs: { "sprint-1": { provider: "claude" } },
        }));
        const { data } = await res.json();
        expect(res.status).toBe(200);
        expect(data.activeMission).toBe("sprint-1");
        expect(data.assignments["dev-worker-1"]).toBe("sprint-1");
        expect(data.llmConfigs["sprint-1"]).toEqual({ provider: "claude" });
      });
    });

    describe("request body validation", () => {
      it("returns 400 for invalid JSON body", async () => {
        const handler = createMissionAssignmentsHandler(makeConfig());
        const req = new Request("http://localhost/api/mission/assignments", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        });
        const res = await handler.PUT(req);
        expect(res.status).toBe(400);
      });

      it("returns 400 when content-type is not application/json", async () => {
        const handler = createMissionAssignmentsHandler(makeConfig());
        const req = new Request("http://localhost/api/mission/assignments", {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify({ activeMission: "main" }),
        });
        const res = await handler.PUT(req);
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.data).toBeNull();
      });

      it("succeeds with empty body (no updates)", async () => {
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({}));
        const { data } = await res.json();
        expect(res.status).toBe(200);
        expect(data.activeMission).toBe("main");
        expect(data.assignments).toEqual({});
      });
    });

    describe("error handling", () => {
      it("returns 500 when writeFileSync throws", async () => {
        mockExistsSync.mockReturnValue(false);
        mockWriteFileSync.mockImplementation(() => {
          throw new Error("EACCES: permission denied");
        });
        const handler = createMissionAssignmentsHandler(makeConfig());
        // empty body — no file existence checks needed, but writeConfig is still called
        const res = await handler.PUT(makePutRequest({}));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.data).toBeNull();
        expect(body.error).toBe("EACCES: permission denied");
      });

      it("returns generic error message when non-Error is thrown", async () => {
        mockWriteFileSync.mockImplementation(() => {
          throw "unexpected string error";
        });
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({}));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe("Failed to update assignments");
      });
    });

    describe("config persistence", () => {
      it("writes updated config as formatted JSON", async () => {
        mockExistsSync.mockReturnValue(false);
        const handler = createMissionAssignmentsHandler(makeConfig());
        await handler.PUT(makePutRequest({}));
        expect(mockWriteFileSync).toHaveBeenCalledWith(
          "/tmp/test/.dev/missions/_config.json",
          expect.stringContaining('"activeMission"'),
          "utf-8",
        );
        // Verify it's pretty-printed (2-space indent) with trailing newline
        const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
        expect(writtenContent).toMatch(/\n$/);
        expect(writtenContent).toContain("  ");
      });

      it("merges with existing config when _config.json exists", async () => {
        const existingConfig = {
          activeMission: "old-mission",
          assignments: { "dev-worker-1": "old-mission" },
        };
        mockExistsSync.mockImplementation((p) => {
          const s = String(p);
          if (s.endsWith("_config.json")) return true;
          if (s.endsWith("new-mission.md")) return true;
          return false;
        });
        mockReadFileSync.mockImplementation((p) => {
          const s = String(p);
          if (s.endsWith("_config.json")) return JSON.stringify(existingConfig);
          return "# New Mission";
        });
        const handler = createMissionAssignmentsHandler(makeConfig());
        const res = await handler.PUT(makePutRequest({
          assignments: { "dev-worker-2": "new-mission" },
        }));
        const { data } = await res.json();
        expect(res.status).toBe(200);
        // Existing assignment preserved
        expect(data.assignments["dev-worker-1"]).toBe("old-mission");
        // New assignment added
        expect(data.assignments["dev-worker-2"]).toBe("new-mission");
        // Active mission unchanged
        expect(data.activeMission).toBe("old-mission");
      });
    });
  });
});
