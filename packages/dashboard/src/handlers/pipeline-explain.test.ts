// NOTE: These tests verify response data shape and status codes but do not assert
// console output (e.g., console.warn for SQLite fallback). Console side effects are
// considered logging concerns and are not part of the handler's contract.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPipelineExplainHandler } from "./pipeline-explain";
import type { SkynetConfig } from "../types";

vi.mock("../lib/file-reader", () => ({
  readDevFile: vi.fn(() => ""),
}));
vi.mock("../lib/db", () => ({
  getSkynetDB: vi.fn(() => { throw new Error("SQLite not available"); }),
}));
vi.mock("../lib/handler-error", () => ({
  logHandlerError: vi.fn(),
}));

import { readDevFile } from "../lib/file-reader";

const mockReadDevFile = vi.mocked(readDevFile);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: [], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

describe("createPipelineExplainHandler", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("returns { data, error: null } envelope on success", async () => {
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toBeDefined();
  });

  it("includes all expected top-level keys in data", async () => {
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data).toHaveProperty("state");
    expect(data).toHaveProperty("completionPct");
    expect(data).toHaveProperty("lagGoals");
    expect(data).toHaveProperty("topBlockers");
    expect(data).toHaveProperty("activeFailures");
    expect(data).toHaveProperty("velocity24h");
    expect(data).toHaveProperty("summary");
  });

  it("returns defaults when mission.md is empty", async () => {
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.state).toBeNull();
    expect(data.completionPct).toBe(0);
    expect(data.lagGoals).toEqual([]);
    expect(data.topBlockers).toEqual([]);
    expect(data.activeFailures).toEqual({});
    expect(data.velocity24h).toBe(0);
  });

  it("parses state from mission.md State line", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## State: active\n\n## Goals\n- [x] Ship MVP\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.state).toBe("active");
  });

  it("parses state without ## prefix", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "State: paused\n\n## Goals\n- [ ] Do things\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.state).toBe("paused");
  });

  it("calculates completionPct from checked goals and criteria", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## State: active\n\n## Goals\n- [x] Goal A\n- [ ] Goal B\n\n## Success Criteria\n- [x] Criterion 1\n- [ ] Criterion 2\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    // 2 checked out of 4 total = 50%
    expect(data.completionPct).toBe(50);
  });

  it("returns 100% completion when all items are checked", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Goals\n- [x] Goal A\n- [x] Goal B\n\n## Success Criteria\n- [x] Criterion 1\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.completionPct).toBe(100);
  });

  it("returns 0% completion when no items are checked", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Goals\n- [ ] Goal A\n- [ ] Goal B\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.completionPct).toBe(0);
  });

  it("populates lagGoals with unchecked goals and criteria", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Goals\n- [x] Done goal\n- [ ] Pending goal\n\n## Success Criteria\n- [ ] Pending criterion\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.lagGoals).toEqual(["Pending goal", "Pending criterion"]);
  });

  it("parses active blockers (max 3)", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "blockers.md") return "## Active\n- Blocker 1\n- Blocker 2\n- Blocker 3\n- Blocker 4\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.topBlockers).toHaveLength(3);
    expect(data.topBlockers).toEqual(["Blocker 1", "Blocker 2", "Blocker 3"]);
  });

  it("returns empty topBlockers when no active blockers", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "blockers.md") return "No active blockers";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.topBlockers).toEqual([]);
  });

  it("classifies active failures by error category", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "failed-tasks.md")
        return [
          "| Date | Task | Branch | Error | Attempts | W | Status |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| 2026-03-01 | T1 | fix/t1 | merge conflict | 1 | 1 | failed |",
          "| 2026-03-01 | T2 | fix/t2 | typecheck fail | 1 | 2 | failed |",
          "| 2026-03-01 | T3 | fix/t3 | merge conflict | 2 | 1 | fixing-1 |",
        ].join("\n");
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.activeFailures["merge conflict"]).toBe(2);
    expect(data.activeFailures["typecheck failure"]).toBe(1);
  });

  it("excludes resolved failures from activeFailures", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "failed-tasks.md")
        return [
          "| Date | Task | Branch | Error | Attempts | W | Status |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| 2026-03-01 | T1 | fix/t1 | merge conflict | 1 | 1 | fixed |",
          "| 2026-03-01 | T2 | fix/t2 | timeout | 1 | 2 | superseded |",
        ].join("\n");
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.activeFailures).toEqual({});
  });

  it("counts velocity24h from completed tasks dated today", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "completed.md")
        return [
          "| Date | Task | Branch | Notes |",
          "| --- | --- | --- | --- |",
          `| ${today} | Task A | fix/a | ok |`,
          `| ${today} | Task B | fix/b | ok |`,
          "| 2025-01-01 | Old task | fix/old | ok |",
        ].join("\n");
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.velocity24h).toBe(2);
  });

  it("builds summary with pipeline state and completion", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## State: active\n\n## Goals\n- [x] Done\n- [ ] Pending\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.summary).toContain("active");
    expect(data.summary).toContain("50%");
  });

  it("summary includes task count for velocity", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "completed.md")
        return `| Date | Task | Branch | Notes |\n| --- | --- | --- | --- |\n| ${today} | T1 | fix/t1 | ok |`;
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.summary).toContain("1 task completed today");
  });

  it("summary says 'No tasks completed today' when velocity is 0", async () => {
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.summary).toContain("No tasks completed today");
  });

  it("summary mentions active failures when present", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "failed-tasks.md")
        return [
          "| Date | Task | Branch | Error | Attempts | W | Status |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| 2026-03-01 | T1 | fix/t1 | timeout | 1 | 1 | failed |",
          "| 2026-03-01 | T2 | fix/t2 | timeout | 1 | 2 | failed |",
        ].join("\n");
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.summary).toContain("2 active failures");
  });

  it("summary mentions active blockers when present", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "blockers.md") return "## Active\n- Missing API key\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.summary).toContain("1 active blocker");
  });

  it("summary mentions lagging goals when present", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Goals\n- [ ] Incomplete goal\n- [ ] Another incomplete\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.summary).toContain("2 goals not yet met");
  });

  it("uses plural 'tasks' for velocity > 1", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "completed.md")
        return [
          "| Date | Task | Branch | Notes |",
          "| --- | --- | --- | --- |",
          `| ${today} | T1 | fix/t1 | ok |`,
          `| ${today} | T2 | fix/t2 | ok |`,
          `| ${today} | T3 | fix/t3 | ok |`,
        ].join("\n");
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.summary).toContain("3 tasks completed today");
  });

  it("returns 500 with error envelope on failure", async () => {
    mockReadDevFile.mockImplementation(() => { throw new Error("Permission denied"); });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Permission denied");
  });

  it("returns generic error message in production mode", async () => {
    process.env.NODE_ENV = "production";
    mockReadDevFile.mockImplementation(() => { throw new Error("Secret error details"); });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to explain pipeline state");
  });

  it("handles mission.md with goals only (no success criteria section)", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## State: active\n\n## Goals\n- [x] Goal A\n- [ ] Goal B\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.completionPct).toBe(50);
    expect(data.lagGoals).toEqual(["Goal B"]);
  });

  it("handles mission.md with success criteria only (no goals section)", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## State: active\n\n## Success Criteria\n- [x] Criterion A\n- [x] Criterion B\n- [ ] Criterion C\n";
      return "";
    });
    const handler = createPipelineExplainHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    // 2 out of 3 = 67%
    expect(data.completionPct).toBe(67);
    expect(data.lagGoals).toEqual(["Criterion C"]);
  });
});
