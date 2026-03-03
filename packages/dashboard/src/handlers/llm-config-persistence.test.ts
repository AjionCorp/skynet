import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SkynetConfig, MissionConfig } from "../types";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "fs";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockUnlinkSync = vi.mocked(unlinkSync);

import { createMissionsHandler } from "./missions";
import { createMissionAssignmentsHandler } from "./mission-assignments";
import { createMissionDetailHandler } from "./mission-detail";

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

function makeRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Simulate a _config.json on disk with the given content */
function mockConfigFile(config: MissionConfig): void {
  const json = JSON.stringify(config, null, 2) + "\n";
  mockReadFileSync.mockImplementation(((path: string) => {
    if (String(path).endsWith("_config.json")) return json;
    // Default: return empty markdown for mission files
    return "# Test Mission\n";
  }) as typeof readFileSync);
}

/** Extract the config written to _config.json from writeFileSync calls */
function getWrittenConfig(): MissionConfig | null {
  for (const call of mockWriteFileSync.mock.calls) {
    if (String(call[0]).endsWith("_config.json")) {
      return JSON.parse(call[1] as string) as MissionConfig;
    }
  }
  return null;
}

// =============================================================================
// Missions handler — POST creates with llmConfig, GET returns it
// =============================================================================

describe("createMissionsHandler — LLM config persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  describe("POST — create mission with llmConfig", () => {
    it("persists llmConfig to _config.json when provided", async () => {
      // Mission file doesn't exist yet (no conflict)
      mockExistsSync.mockImplementation(((path: string) => {
        if (String(path).endsWith("feature-x.md")) return false;
        return true;
      }) as typeof existsSync);

      mockConfigFile({ activeMission: "main", assignments: {} });

      const { POST } = createMissionsHandler(makeConfig());
      const res = await POST(
        makeRequest("http://localhost/api/missions", "POST", {
          name: "Feature X",
          llmConfig: { provider: "claude", model: "claude-opus-4-6" },
        }),
      );
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.slug).toBe("feature-x");

      const written = getWrittenConfig();
      expect(written).not.toBeNull();
      expect(written!.llmConfigs).toBeDefined();
      expect(written!.llmConfigs!["feature-x"]).toEqual({
        provider: "claude",
        model: "claude-opus-4-6",
      });
    });

    it("persists llmConfig with provider only (no model)", async () => {
      mockExistsSync.mockImplementation(((path: string) => {
        if (String(path).endsWith("auto-mission.md")) return false;
        return true;
      }) as typeof existsSync);

      mockConfigFile({ activeMission: "main", assignments: {} });

      const { POST } = createMissionsHandler(makeConfig());
      const res = await POST(
        makeRequest("http://localhost/api/missions", "POST", {
          name: "Auto Mission",
          llmConfig: { provider: "auto" },
        }),
      );

      expect(res.status).toBe(201);

      const written = getWrittenConfig();
      expect(written!.llmConfigs!["auto-mission"]).toEqual({
        provider: "auto",
      });
      // model key should be absent, not undefined
      expect("model" in written!.llmConfigs!["auto-mission"]).toBe(false);
    });

    it("defaults to auto provider when llmConfig not provided", async () => {
      mockExistsSync.mockImplementation(((path: string) => {
        if (String(path).endsWith("plain-mission.md")) return false;
        return true;
      }) as typeof existsSync);

      mockConfigFile({ activeMission: "main", assignments: {} });

      const { POST } = createMissionsHandler(makeConfig());
      const res = await POST(
        makeRequest("http://localhost/api/missions", "POST", {
          name: "Plain Mission",
        }),
      );

      expect(res.status).toBe(201);

      // Handler defaults to { provider: "auto" } when no llmConfig provided
      const written = getWrittenConfig();
      expect(written!.llmConfigs!["plain-mission"]).toEqual({
        provider: "auto",
      });
    });

    it("preserves existing llmConfigs when adding a new one", async () => {
      mockExistsSync.mockImplementation(((path: string) => {
        if (String(path).endsWith("new-mission.md")) return false;
        return true;
      }) as typeof existsSync);

      mockConfigFile({
        activeMission: "main",
        assignments: {},
        llmConfigs: {
          existing: { provider: "gemini", model: "gemini-2.5-pro" },
        },
      });

      const { POST } = createMissionsHandler(makeConfig());
      const res = await POST(
        makeRequest("http://localhost/api/missions", "POST", {
          name: "New Mission",
          llmConfig: { provider: "codex" },
        }),
      );

      expect(res.status).toBe(201);

      const written = getWrittenConfig();
      expect(written!.llmConfigs!["existing"]).toEqual({
        provider: "gemini",
        model: "gemini-2.5-pro",
      });
      expect(written!.llmConfigs!["new-mission"]).toEqual({
        provider: "codex",
      });
    });
  });

  describe("GET — returns llmConfig per mission", () => {
    it("includes llmConfig in mission summaries", async () => {
      mockReaddirSync.mockReturnValue(["main.md", "feature-x.md"] as unknown as ReturnType<typeof readdirSync>);

      mockConfigFile({
        activeMission: "main",
        assignments: {},
        llmConfigs: {
          "feature-x": { provider: "claude", model: "claude-opus-4-6" },
        },
      });

      const { GET } = createMissionsHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      const missions = body.data.missions;
      const featureX = missions.find((m: { slug: string }) => m.slug === "feature-x");
      const main = missions.find((m: { slug: string }) => m.slug === "main");

      expect(featureX.llmConfig).toEqual({
        provider: "claude",
        model: "claude-opus-4-6",
      });
      // main has no explicit config → defaults to { provider: "auto" }
      expect(main.llmConfig).toEqual({ provider: "auto" });
    });

    it("returns default auto provider when none configured", async () => {
      mockReaddirSync.mockReturnValue(["main.md"] as unknown as ReturnType<typeof readdirSync>);

      mockConfigFile({ activeMission: "main", assignments: {} });

      const { GET } = createMissionsHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      const main = body.data.missions[0];
      expect(main.llmConfig).toEqual({ provider: "auto" });
    });
  });
});

// =============================================================================
// Mission Assignments handler — GET reads, PUT updates llmConfigs
// =============================================================================

describe("createMissionAssignmentsHandler — LLM config persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  describe("GET — returns llmConfigs from config", () => {
    it("returns llmConfigs in the config data", async () => {
      mockConfigFile({
        activeMission: "main",
        assignments: { "dev-worker-1": "main" },
        llmConfigs: {
          main: { provider: "claude", model: "claude-opus-4-6" },
          "feature-y": { provider: "auto" },
        },
      });

      const { GET } = createMissionAssignmentsHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.llmConfigs).toEqual({
        main: { provider: "claude", model: "claude-opus-4-6" },
        "feature-y": { provider: "auto" },
      });
    });

    it("returns config without llmConfigs when none exist", async () => {
      mockConfigFile({ activeMission: "main", assignments: {} });

      const { GET } = createMissionAssignmentsHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.llmConfigs).toBeUndefined();
    });
  });

  describe("PUT — updates llmConfigs", () => {
    it("sets llmConfig for a mission via PUT", async () => {
      mockConfigFile({ activeMission: "main", assignments: {} });

      const { PUT } = createMissionAssignmentsHandler(makeConfig());
      const res = await PUT(
        makeRequest("http://localhost/api/mission-assignments", "PUT", {
          llmConfigs: {
            main: { provider: "gemini", model: "gemini-2.5-pro" },
          },
        }),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.llmConfigs).toEqual({
        main: { provider: "gemini", model: "gemini-2.5-pro" },
      });

      const written = getWrittenConfig();
      expect(written!.llmConfigs!["main"]).toEqual({
        provider: "gemini",
        model: "gemini-2.5-pro",
      });
    });

    it("merges llmConfigs with existing configs", async () => {
      mockConfigFile({
        activeMission: "main",
        assignments: {},
        llmConfigs: {
          main: { provider: "claude" },
        },
      });

      const { PUT } = createMissionAssignmentsHandler(makeConfig());
      const res = await PUT(
        makeRequest("http://localhost/api/mission-assignments", "PUT", {
          llmConfigs: {
            "feature-y": { provider: "codex", model: "codex-mini-latest" },
          },
        }),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      // Both the old and new config should be present
      expect(body.data.llmConfigs!["main"]).toEqual({ provider: "claude" });
      expect(body.data.llmConfigs!["feature-y"]).toEqual({
        provider: "codex",
        model: "codex-mini-latest",
      });
    });

    it("overwrites existing llmConfig for same mission", async () => {
      mockConfigFile({
        activeMission: "main",
        assignments: {},
        llmConfigs: {
          main: { provider: "claude", model: "claude-opus-4-6" },
        },
      });

      const { PUT } = createMissionAssignmentsHandler(makeConfig());
      const res = await PUT(
        makeRequest("http://localhost/api/mission-assignments", "PUT", {
          llmConfigs: {
            main: { provider: "auto" },
          },
        }),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.llmConfigs!["main"]).toEqual({ provider: "auto" });
    });

    it("rejects llmConfig for non-existent mission", async () => {
      mockExistsSync.mockImplementation(((path: string) => {
        if (String(path).endsWith("ghost.md")) return false;
        return true;
      }) as typeof existsSync);

      mockConfigFile({ activeMission: "main", assignments: {} });

      const { PUT } = createMissionAssignmentsHandler(makeConfig());
      const res = await PUT(
        makeRequest("http://localhost/api/mission-assignments", "PUT", {
          llmConfigs: {
            ghost: { provider: "claude" },
          },
        }),
      );
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toContain("ghost");
      expect(body.error).toContain("not found");
    });

    it("updates llmConfigs alongside assignments in a single PUT", async () => {
      mockConfigFile({ activeMission: "main", assignments: {} });

      const { PUT } = createMissionAssignmentsHandler(makeConfig());
      const res = await PUT(
        makeRequest("http://localhost/api/mission-assignments", "PUT", {
          assignments: { "dev-worker-1": "main" },
          llmConfigs: {
            main: { provider: "claude", model: "claude-opus-4-6" },
          },
        }),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.assignments["dev-worker-1"]).toBe("main");
      expect(body.data.llmConfigs!["main"]).toEqual({
        provider: "claude",
        model: "claude-opus-4-6",
      });
    });
  });
});

// =============================================================================
// Mission Detail handler — GET returns llmConfig, DELETE cleans it up
// =============================================================================

describe("createMissionDetailHandler — LLM config persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  describe("GET — returns llmConfig for specific mission", () => {
    it("includes llmConfig in mission detail", async () => {
      mockConfigFile({
        activeMission: "main",
        assignments: {},
        llmConfigs: {
          "feature-x": { provider: "codex", model: "codex-mini-latest" },
        },
      });

      const { GET } = createMissionDetailHandler(makeConfig());
      const res = await GET(
        new Request("http://localhost/api/admin/missions/feature-x"),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.llmConfig).toEqual({
        provider: "codex",
        model: "codex-mini-latest",
      });
    });

    it("returns default auto provider when not configured for this mission", async () => {
      mockConfigFile({
        activeMission: "main",
        assignments: {},
        llmConfigs: {
          other: { provider: "claude" },
        },
      });

      const { GET } = createMissionDetailHandler(makeConfig());
      const res = await GET(
        new Request("http://localhost/api/admin/missions/main"),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.llmConfig).toEqual({ provider: "auto" });
    });
  });

  describe("DELETE — removes llmConfig when mission is deleted", () => {
    it("removes llmConfig entry on mission deletion", async () => {
      mockExistsSync.mockImplementation(((path: string) => {
        return true; // All files exist
      }) as typeof existsSync);

      mockConfigFile({
        activeMission: "main",
        assignments: { "dev-worker-1": "doomed" },
        llmConfigs: {
          main: { provider: "claude" },
          doomed: { provider: "gemini", model: "gemini-2.5-pro" },
        },
      });

      const { DELETE } = createMissionDetailHandler(makeConfig());
      const res = await DELETE(
        new Request("http://localhost/api/admin/missions/doomed", {
          method: "DELETE",
        }),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.deleted).toBe(true);
      expect(mockUnlinkSync).toHaveBeenCalled();

      const written = getWrittenConfig();
      expect(written).not.toBeNull();
      // doomed llmConfig should be removed
      expect(written!.llmConfigs!["doomed"]).toBeUndefined();
      // main llmConfig should be preserved
      expect(written!.llmConfigs!["main"]).toEqual({ provider: "claude" });
      // Worker assignment for doomed should be nulled
      expect(written!.assignments["dev-worker-1"]).toBeNull();
    });

    it("does not rewrite config if deleted mission had no llmConfig or assignments", async () => {
      mockConfigFile({
        activeMission: "main",
        assignments: {},
        llmConfigs: {
          main: { provider: "claude" },
        },
      });

      const { DELETE } = createMissionDetailHandler(makeConfig());
      const res = await DELETE(
        new Request("http://localhost/api/admin/missions/orphan", {
          method: "DELETE",
        }),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.deleted).toBe(true);

      // _config.json should not have been rewritten (no changes needed)
      const configWrites = mockWriteFileSync.mock.calls.filter((call) =>
        String(call[0]).endsWith("_config.json"),
      );
      expect(configWrites).toHaveLength(0);
    });

    it("refuses to delete the active mission", async () => {
      mockConfigFile({
        activeMission: "active-one",
        assignments: {},
        llmConfigs: {
          "active-one": { provider: "claude" },
        },
      });

      const { DELETE } = createMissionDetailHandler(makeConfig());
      const res = await DELETE(
        new Request("http://localhost/api/admin/missions/active-one", {
          method: "DELETE",
        }),
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error).toContain("active mission");
      // llmConfig should NOT have been touched
      expect(getWrittenConfig()).toBeNull();
    });
  });
});

// =============================================================================
// Round-trip integration: POST → GET → PUT → GET → DELETE → GET
// =============================================================================

describe("LLM config round-trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it("config survives create → read → update → read cycle", async () => {
    // Phase 1: Create mission with llmConfig
    mockExistsSync.mockImplementation(((path: string) => {
      if (String(path).endsWith("round-trip.md")) return false;
      return true;
    }) as typeof existsSync);

    mockConfigFile({ activeMission: "main", assignments: {} });

    const missionsHandler = createMissionsHandler(makeConfig());
    const createRes = await missionsHandler.POST(
      makeRequest("http://localhost/api/missions", "POST", {
        name: "Round Trip",
        llmConfig: { provider: "claude", model: "claude-opus-4-6" },
      }),
    );
    expect(createRes.status).toBe(201);

    // Capture what was written
    const afterCreate = getWrittenConfig();
    expect(afterCreate!.llmConfigs!["round-trip"]).toEqual({
      provider: "claude",
      model: "claude-opus-4-6",
    });

    // Phase 2: Read back via assignments GET (simulate reading what was written)
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockConfigFile(afterCreate!);

    const assignmentsHandler = createMissionAssignmentsHandler(makeConfig());
    const readRes = await assignmentsHandler.GET();
    const readBody = await readRes.json();

    expect(readBody.data.llmConfigs!["round-trip"]).toEqual({
      provider: "claude",
      model: "claude-opus-4-6",
    });

    // Phase 3: Update via assignments PUT
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockConfigFile(afterCreate!);

    const updateRes = await assignmentsHandler.PUT(
      makeRequest("http://localhost/api/mission-assignments", "PUT", {
        llmConfigs: {
          "round-trip": { provider: "gemini", model: "gemini-2.5-pro" },
        },
      }),
    );
    const updateBody = await updateRes.json();

    expect(updateRes.status).toBe(200);
    expect(updateBody.data.llmConfigs!["round-trip"]).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });

    // Verify the written config matches
    const afterUpdate = getWrittenConfig();
    expect(afterUpdate!.llmConfigs!["round-trip"]).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
  });

  it("full lifecycle: create → detail GET → update → list GET → delete → verify cleanup", async () => {
    // Phase 1: Create mission with explicit llmConfig
    mockExistsSync.mockImplementation(((path: string) => {
      if (String(path).endsWith("lifecycle.md")) return false;
      return true;
    }) as typeof existsSync);

    mockConfigFile({ activeMission: "main", assignments: {} });

    const missionsHandler = createMissionsHandler(makeConfig());
    const createRes = await missionsHandler.POST(
      makeRequest("http://localhost/api/missions", "POST", {
        name: "Lifecycle",
        llmConfig: { provider: "codex", model: "codex-mini-latest" },
      }),
    );
    expect(createRes.status).toBe(201);

    const afterCreate = getWrittenConfig();
    expect(afterCreate!.llmConfigs!["lifecycle"]).toEqual({
      provider: "codex",
      model: "codex-mini-latest",
    });

    // Phase 2: Read back via mission-detail GET
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockConfigFile(afterCreate!);

    const detailHandler = createMissionDetailHandler(makeConfig());
    const detailRes = await detailHandler.GET(
      new Request("http://localhost/api/admin/missions/lifecycle"),
    );
    const detailBody = await detailRes.json();

    expect(detailRes.status).toBe(200);
    expect(detailBody.data.llmConfig).toEqual({
      provider: "codex",
      model: "codex-mini-latest",
    });

    // Phase 3: Update via assignments PUT
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockConfigFile(afterCreate!);

    const assignmentsHandler = createMissionAssignmentsHandler(makeConfig());
    const updateRes = await assignmentsHandler.PUT(
      makeRequest("http://localhost/api/mission-assignments", "PUT", {
        llmConfigs: {
          lifecycle: { provider: "claude", model: "claude-opus-4-6" },
        },
      }),
    );
    expect(updateRes.status).toBe(200);

    const afterUpdate = getWrittenConfig();

    // Phase 4: Verify via missions list GET
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["main.md", "lifecycle.md"] as unknown as ReturnType<typeof readdirSync>);
    mockConfigFile(afterUpdate!);

    const listRes = await missionsHandler.GET();
    const listBody = await listRes.json();
    const lifecycle = listBody.data.missions.find((m: { slug: string }) => m.slug === "lifecycle");

    expect(lifecycle.llmConfig).toEqual({
      provider: "claude",
      model: "claude-opus-4-6",
    });

    // Phase 5: Delete mission → verify llmConfig cleaned up
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockConfigFile(afterUpdate!);

    const deleteRes = await detailHandler.DELETE(
      new Request("http://localhost/api/admin/missions/lifecycle", {
        method: "DELETE",
      }),
    );
    expect(deleteRes.status).toBe(200);

    const afterDelete = getWrittenConfig();
    expect(afterDelete!.llmConfigs!["lifecycle"]).toBeUndefined();
    // main should still be untouched
    expect(afterDelete!.activeMission).toBe("main");
  });

  it("multi-mission configs are isolated across create and update", async () => {
    // Create two missions with different configs
    const baseConfig: MissionConfig = { activeMission: "main", assignments: {} };

    // Create mission A
    mockExistsSync.mockImplementation(((path: string) => {
      if (String(path).endsWith("alpha.md")) return false;
      return true;
    }) as typeof existsSync);
    mockConfigFile(baseConfig);

    const missionsHandler = createMissionsHandler(makeConfig());
    const resA = await missionsHandler.POST(
      makeRequest("http://localhost/api/missions", "POST", {
        name: "Alpha",
        llmConfig: { provider: "claude", model: "claude-opus-4-6" },
      }),
    );
    expect(resA.status).toBe(201);
    const afterA = getWrittenConfig();

    // Create mission B (starting from state after A was created)
    vi.clearAllMocks();
    mockExistsSync.mockImplementation(((path: string) => {
      if (String(path).endsWith("beta.md")) return false;
      return true;
    }) as typeof existsSync);
    mockConfigFile(afterA!);

    const resB = await missionsHandler.POST(
      makeRequest("http://localhost/api/missions", "POST", {
        name: "Beta",
        llmConfig: { provider: "gemini", model: "gemini-2.5-pro" },
      }),
    );
    expect(resB.status).toBe(201);
    const afterB = getWrittenConfig();

    // Both configs should coexist
    expect(afterB!.llmConfigs!["alpha"]).toEqual({
      provider: "claude",
      model: "claude-opus-4-6",
    });
    expect(afterB!.llmConfigs!["beta"]).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });

    // Update only alpha → beta should be unchanged
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockConfigFile(afterB!);

    const assignmentsHandler = createMissionAssignmentsHandler(makeConfig());
    const updateRes = await assignmentsHandler.PUT(
      makeRequest("http://localhost/api/mission-assignments", "PUT", {
        llmConfigs: {
          alpha: { provider: "auto" },
        },
      }),
    );
    expect(updateRes.status).toBe(200);

    const afterUpdate = getWrittenConfig();
    expect(afterUpdate!.llmConfigs!["alpha"]).toEqual({ provider: "auto" });
    expect(afterUpdate!.llmConfigs!["beta"]).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
  });

  it("provider downgrade: explicit config → auto round-trips correctly", async () => {
    // Start with explicit config
    const initial: MissionConfig = {
      activeMission: "main",
      assignments: {},
      llmConfigs: {
        main: { provider: "claude", model: "claude-opus-4-6" },
      },
    };

    mockConfigFile(initial);

    // Downgrade to auto via assignments PUT
    const assignmentsHandler = createMissionAssignmentsHandler(makeConfig());
    const downgradeRes = await assignmentsHandler.PUT(
      makeRequest("http://localhost/api/mission-assignments", "PUT", {
        llmConfigs: {
          main: { provider: "auto" },
        },
      }),
    );
    expect(downgradeRes.status).toBe(200);

    const afterDowngrade = getWrittenConfig();
    expect(afterDowngrade!.llmConfigs!["main"]).toEqual({ provider: "auto" });
    // model should not be carried over from previous config
    expect(afterDowngrade!.llmConfigs!["main"].model).toBeUndefined();

    // Verify via detail GET
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockConfigFile(afterDowngrade!);

    const detailHandler = createMissionDetailHandler(makeConfig());
    const detailRes = await detailHandler.GET(
      new Request("http://localhost/api/admin/missions/main"),
    );
    const body = await detailRes.json();

    expect(body.data.llmConfig).toEqual({ provider: "auto" });
  });

  it("default auto config from POST is readable through all GET paths", async () => {
    // Create mission without explicit llmConfig → should default to auto
    mockExistsSync.mockImplementation(((path: string) => {
      if (String(path).endsWith("no-config.md")) return false;
      return true;
    }) as typeof existsSync);

    mockConfigFile({ activeMission: "main", assignments: {} });

    const missionsHandler = createMissionsHandler(makeConfig());
    const createRes = await missionsHandler.POST(
      makeRequest("http://localhost/api/missions", "POST", {
        name: "No Config",
      }),
    );
    expect(createRes.status).toBe(201);

    const afterCreate = getWrittenConfig();
    expect(afterCreate!.llmConfigs!["no-config"]).toEqual({ provider: "auto" });

    // Read via detail GET
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockConfigFile(afterCreate!);

    const detailHandler = createMissionDetailHandler(makeConfig());
    const detailRes = await detailHandler.GET(
      new Request("http://localhost/api/admin/missions/no-config"),
    );
    const detailBody = await detailRes.json();
    expect(detailBody.data.llmConfig).toEqual({ provider: "auto" });

    // Read via assignments GET
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockConfigFile(afterCreate!);

    const assignmentsHandler = createMissionAssignmentsHandler(makeConfig());
    const assignRes = await assignmentsHandler.GET();
    const assignBody = await assignRes.json();
    expect(assignBody.data.llmConfigs!["no-config"]).toEqual({ provider: "auto" });

    // Read via missions list GET
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["main.md", "no-config.md"] as unknown as ReturnType<typeof readdirSync>);
    mockConfigFile(afterCreate!);

    const listRes = await missionsHandler.GET();
    const listBody = await listRes.json();
    const mission = listBody.data.missions.find((m: { slug: string }) => m.slug === "no-config");
    expect(mission.llmConfig).toEqual({ provider: "auto" });
  });
});
