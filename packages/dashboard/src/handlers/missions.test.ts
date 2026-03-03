import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMissionsHandler } from "./missions";
import type { SkynetConfig } from "../types";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

vi.mock("../lib/parse-body", () => ({
  parseBody: vi.fn(async () => ({ data: null, error: null })),
}));

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { parseBody } from "../lib/parse-body";

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockCopyFileSync = vi.mocked(copyFileSync);
const mockParseBody = vi.mocked(parseBody);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: [], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/missions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createMissionsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: missions dir exists, config exists with defaults
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("/missions")) return true;
      if (path.endsWith("_config.json")) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValue('{"activeMission":"main","assignments":{}}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET", () => {
    it("returns { data, error: null } envelope on success", async () => {
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data).toBeDefined();
    });

    it("returns empty missions array when no .md files exist", async () => {
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions).toEqual([]);
    });

    it("returns config alongside missions", async () => {
      mockReadFileSync.mockReturnValue('{"activeMission":"main","assignments":{"dev-worker-1":"main"}}');
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.config).toEqual({ activeMission: "main", assignments: { "dev-worker-1": "main" } });
    });

    it("lists .md files as missions with slug and name from heading", async () => {
      mockReaddirSync.mockReturnValue(["main.md", "feature-x.md"] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
        if (path.endsWith("main.md")) return "# Main Mission\n\n## Purpose\nDo things\n";
        if (path.endsWith("feature-x.md")) return "# Feature X\n\n## Goals\n- [ ] Build it\n";
        return "";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions).toHaveLength(2);
      expect(data.missions[0].slug).toBe("main");
      expect(data.missions[0].name).toBe("Main Mission");
      expect(data.missions[1].slug).toBe("feature-x");
      expect(data.missions[1].name).toBe("Feature X");
    });

    it("uses slug as name when no heading is present", async () => {
      mockReaddirSync.mockReturnValue(["no-heading.md"] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
        if (path.endsWith("no-heading.md")) return "Just some text without a heading.\n";
        return "";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions[0].name).toBe("no-heading");
    });

    it("marks the active mission based on config", async () => {
      mockReaddirSync.mockReturnValue(["main.md", "other.md"] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
        return "# Test\n";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions.find((m: { slug: string }) => m.slug === "main").isActive).toBe(true);
      expect(data.missions.find((m: { slug: string }) => m.slug === "other").isActive).toBe(false);
    });

    it("assigns workers to missions from config assignments", async () => {
      mockReaddirSync.mockReturnValue(["main.md"] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{"dev-worker-1":"main","dev-worker-2":"main","task-fixer-1":"other"}}';
        return "# Main\n";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions[0].assignedWorkers).toEqual(["dev-worker-1", "dev-worker-2"]);
    });

    it("calculates 0% completion when no success criteria exist", async () => {
      mockReaddirSync.mockReturnValue(["main.md"] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
        return "# Main\n\n## Purpose\nJust a purpose.\n";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions[0].completionPercentage).toBe(0);
    });

    it("calculates 100% when all criteria are checked", async () => {
      mockReaddirSync.mockReturnValue(["main.md"] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
        return "# Main\n\n## Success Criteria\n- [x] Tests pass\n- [x] Docs done\n";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions[0].completionPercentage).toBe(100);
    });

    it("calculates 0% when first checkbox is unchecked", async () => {
      mockReaddirSync.mockReturnValue(["main.md"] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
        return "# Main\n\n## Success Criteria\n- [ ] Not done yet\n";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions[0].completionPercentage).toBe(0);
    });

    it("recognizes uppercase [X] as completed", async () => {
      mockReaddirSync.mockReturnValue(["main.md"] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
        return "# Main\n\n## Success Criteria\n- [X] Done with uppercase\n";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions[0].completionPercentage).toBe(100);
    });

    it("returns llmConfig from config or defaults to auto", async () => {
      mockReaddirSync.mockReturnValue(["main.md", "other.md"] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{},"llmConfigs":{"main":{"provider":"claude","model":"opus"}}}';
        return "# Test\n";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions.find((m: { slug: string }) => m.slug === "main").llmConfig).toEqual({ provider: "claude", model: "opus" });
      expect(data.missions.find((m: { slug: string }) => m.slug === "other").llmConfig).toEqual({ provider: "auto" });
    });

    it("excludes files starting with underscore", async () => {
      mockReaddirSync.mockReturnValue(["main.md", "_config.md", "_hidden.md"] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
        return "# Test\n";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions).toHaveLength(1);
      expect(data.missions[0].slug).toBe("main");
    });

    it("excludes non-.md files", async () => {
      mockReaddirSync.mockReturnValue(["main.md", "_config.json", "notes.txt"] as unknown as ReturnType<typeof readdirSync>);
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{}}';
        return "# Test\n";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.missions).toHaveLength(1);
    });

    it("returns 500 with error envelope when readdirSync throws", async () => {
      mockReaddirSync.mockImplementation(() => { throw new Error("Permission denied"); });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Permission denied");
    });

    it("returns generic error when non-Error is thrown", async () => {
      mockReaddirSync.mockImplementation(() => { throw "unexpected string"; });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Failed to list missions");
    });
  });

  describe("ensureMissionsDir (auto-migration)", () => {
    it("creates missions dir when it does not exist", async () => {
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/missions")) return false;
        return false;
      });

      const handler = createMissionsHandler(makeConfig());
      await handler.GET();
      expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/test/.dev/missions", { recursive: true });
    });

    it("does not create missions dir when it already exists", async () => {
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/missions")) return true;
        if (path.endsWith("_config.json")) return true;
        return false;
      });

      const handler = createMissionsHandler(makeConfig());
      await handler.GET();
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it("copies legacy mission.md to missions/main.md during migration", async () => {
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/missions")) return false;
        if (path.endsWith("mission.md")) return true;
        return false;
      });

      const handler = createMissionsHandler(makeConfig());
      await handler.GET();
      expect(mockCopyFileSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/mission.md",
        "/tmp/test/.dev/missions/main.md",
      );
    });

    it("skips legacy copy when mission.md does not exist", async () => {
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/missions")) return false;
        if (path.endsWith("mission.md")) return false;
        return false;
      });

      const handler = createMissionsHandler(makeConfig());
      await handler.GET();
      expect(mockCopyFileSync).not.toHaveBeenCalled();
    });

    it("writes default _config.json during migration", async () => {
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/missions")) return false;
        return false;
      });

      const handler = createMissionsHandler(makeConfig());
      await handler.GET();
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/missions/_config.json",
        JSON.stringify({ activeMission: "main", assignments: {} }, null, 2) + "\n",
        "utf-8",
      );
    });
  });

  describe("readConfig", () => {
    it("returns defaults when _config.json does not exist", async () => {
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/missions")) return true;
        if (path.endsWith("_config.json")) return false;
        return false;
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.config).toEqual({ activeMission: "main", assignments: {} });
    });

    it("returns defaults when _config.json contains invalid JSON", async () => {
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/missions")) return true;
        if (path.endsWith("_config.json")) return true;
        return false;
      });
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return "not valid json{{{";
        return "";
      });

      const handler = createMissionsHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.config).toEqual({ activeMission: "main", assignments: {} });
    });
  });

  describe("POST", () => {
    beforeEach(() => {
      // Default: mission file does not exist yet
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/missions")) return true;
        if (path.endsWith("_config.json")) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue('{"activeMission":"main","assignments":{}}');
    });

    it("creates a new mission and returns 201 with slug", async () => {
      mockParseBody.mockResolvedValue({ data: { name: "Feature Alpha", content: "# Feature Alpha\n\nContent here" }, error: null });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.POST(makeRequest({}));
      const body = await res.json();
      expect(res.status).toBe(201);
      expect(body.error).toBeNull();
      expect(body.data.slug).toBe("feature-alpha");
      expect(body.data.name).toBe("Feature Alpha");
    });

    it("writes mission content to the correct file path", async () => {
      mockParseBody.mockResolvedValue({ data: { name: "My Mission", content: "# Custom Content" }, error: null });
      const handler = createMissionsHandler(makeConfig());
      await handler.POST(makeRequest({}));
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/missions/my-mission.md",
        "# Custom Content",
        "utf-8",
      );
    });

    it("generates default template when content is not provided", async () => {
      mockParseBody.mockResolvedValue({ data: { name: "New Mission" }, error: null });
      const handler = createMissionsHandler(makeConfig());
      await handler.POST(makeRequest({}));
      const writeCall = mockWriteFileSync.mock.calls.find((c) => String(c[0]).endsWith("new-mission.md"));
      expect(writeCall).toBeDefined();
      const written = writeCall![1] as string;
      expect(written).toContain("# New Mission");
      expect(written).toContain("## Purpose");
      expect(written).toContain("## Goals");
      expect(written).toContain("## Success Criteria");
    });

    it("generates default template when content is empty string", async () => {
      mockParseBody.mockResolvedValue({ data: { name: "Empty Content", content: "  " }, error: null });
      const handler = createMissionsHandler(makeConfig());
      await handler.POST(makeRequest({}));
      const writeCall = mockWriteFileSync.mock.calls.find((c) => String(c[0]).endsWith("empty-content.md"));
      expect(writeCall).toBeDefined();
      const written = writeCall![1] as string;
      expect(written).toContain("# Empty Content");
    });

    it("returns 400 when parseBody returns an error", async () => {
      mockParseBody.mockResolvedValue({ data: null, error: "Invalid JSON body" });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.POST(makeRequest({}));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 400 when name is missing", async () => {
      mockParseBody.mockResolvedValue({ data: { content: "some content" }, error: null });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.POST(makeRequest({}));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing 'name' field (string)");
    });

    it("returns 400 when name is empty string", async () => {
      mockParseBody.mockResolvedValue({ data: { name: "   " }, error: null });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.POST(makeRequest({}));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing 'name' field (string)");
    });

    it("returns 400 when name is not a string", async () => {
      mockParseBody.mockResolvedValue({ data: { name: 123 }, error: null });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.POST(makeRequest({}));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing 'name' field (string)");
    });

    it("returns 409 when mission already exists", async () => {
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/missions")) return true;
        if (path.endsWith("_config.json")) return true;
        if (path.endsWith("existing.md")) return true;
        return false;
      });
      mockParseBody.mockResolvedValue({ data: { name: "Existing" }, error: null });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.POST(makeRequest({}));
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toBe("Mission 'existing' already exists");
    });

    it("slugifies mission name correctly", async () => {
      mockParseBody.mockResolvedValue({ data: { name: "My   Great--Mission!!!" }, error: null });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.POST(makeRequest({}));
      const body = await res.json();
      expect(body.data.slug).toBe("my-great-mission");
    });

    it("truncates slug to 64 characters", async () => {
      const longName = "a".repeat(100);
      mockParseBody.mockResolvedValue({ data: { name: longName }, error: null });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.POST(makeRequest({}));
      const body = await res.json();
      expect(body.data.slug.length).toBeLessThanOrEqual(64);
    });

    it("saves llmConfig when provided", async () => {
      mockParseBody.mockResolvedValue({
        data: { name: "LLM Test", llmConfig: { provider: "claude", model: "opus" } },
        error: null,
      });
      const handler = createMissionsHandler(makeConfig());
      await handler.POST(makeRequest({}));

      // Find the config write (second writeFileSync call — first is mission content)
      const configWrite = mockWriteFileSync.mock.calls.find((c) => String(c[0]).endsWith("_config.json"));
      expect(configWrite).toBeDefined();
      const writtenConfig = JSON.parse(configWrite![1] as string);
      expect(writtenConfig.llmConfigs["llm-test"]).toEqual({ provider: "claude", model: "opus" });
    });

    it("defaults llmConfig to auto when not provided", async () => {
      mockParseBody.mockResolvedValue({ data: { name: "No LLM" }, error: null });
      const handler = createMissionsHandler(makeConfig());
      await handler.POST(makeRequest({}));

      const configWrite = mockWriteFileSync.mock.calls.find((c) => String(c[0]).endsWith("_config.json"));
      expect(configWrite).toBeDefined();
      const writtenConfig = JSON.parse(configWrite![1] as string);
      expect(writtenConfig.llmConfigs["no-llm"]).toEqual({ provider: "auto" });
    });

    it("preserves existing llmConfigs when adding new mission", async () => {
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("_config.json")) return '{"activeMission":"main","assignments":{},"llmConfigs":{"main":{"provider":"claude"}}}';
        return "";
      });
      mockParseBody.mockResolvedValue({ data: { name: "Second" }, error: null });
      const handler = createMissionsHandler(makeConfig());
      await handler.POST(makeRequest({}));

      const configWrite = mockWriteFileSync.mock.calls.find((c) => String(c[0]).endsWith("_config.json"));
      const writtenConfig = JSON.parse(configWrite![1] as string);
      expect(writtenConfig.llmConfigs.main).toEqual({ provider: "claude" });
      expect(writtenConfig.llmConfigs.second).toEqual({ provider: "auto" });
    });

    it("returns 500 when writeFileSync throws", async () => {
      mockParseBody.mockResolvedValue({ data: { name: "Failing" }, error: null });
      mockWriteFileSync.mockImplementation(() => { throw new Error("Disk full"); });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.POST(makeRequest({}));
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Disk full");
    });

    it("returns generic error when non-Error is thrown in POST", async () => {
      mockParseBody.mockResolvedValue({ data: { name: "Bad" }, error: null });
      mockWriteFileSync.mockImplementation(() => { throw 42; });
      const handler = createMissionsHandler(makeConfig());
      const res = await handler.POST(makeRequest({}));
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.error).toBe("Failed to create mission");
    });
  });
});
