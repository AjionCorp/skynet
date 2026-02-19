import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMissionStatusHandler } from "./mission-status";
import type { SkynetConfig } from "../types";

vi.mock("../lib/file-reader", () => ({
  readDevFile: vi.fn(() => ""),
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

describe("createMissionStatusHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
  });

  it("returns { data, error: null } envelope on success", async () => {
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toBeDefined();
  });

  it("includes all expected top-level keys when mission.md is empty", async () => {
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.purpose).toBeNull();
    expect(data.goals).toEqual([]);
    expect(data.successCriteria).toEqual([]);
    expect(data.currentFocus).toBeNull();
    expect(data.completionPercentage).toBe(0);
    expect(data.raw).toBe("");
  });

  it("parses ## Purpose section text", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Purpose\n\nBuild the best pipeline ever.\nAutomate all the things.\n\n## Goals\n";
      return "";
    });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.purpose).toBe("Build the best pipeline ever. Automate all the things.");
  });

  it("parses ## Current Focus section text", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Current Focus\n\nShipping v2 release\n";
      return "";
    });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.currentFocus).toBe("Shipping v2 release");
  });

  it("parses checkbox criteria with [x] as completed", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Success Criteria\n\n- [x] All tests passing\n- [ ] Documentation updated\n";
      return "";
    });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.successCriteria).toHaveLength(2);
    expect(data.successCriteria[0]).toEqual({ text: "All tests passing", completed: true });
    expect(data.successCriteria[1]).toEqual({ text: "Documentation updated", completed: false });
  });

  it("parses numbered items as pending criteria", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Goals\n\n1. Ship the MVP\n2. Gather feedback\n";
      return "";
    });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.goals).toHaveLength(2);
    expect(data.goals[0]).toEqual({ text: "Ship the MVP", completed: false });
    expect(data.goals[1]).toEqual({ text: "Gather feedback", completed: false });
  });

  it("parses bullet items as pending but skips 'The mission...' preamble", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Success Criteria\n\n- The mission is complete when:\n- Full test coverage\n- CI pipeline green\n";
      return "";
    });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.successCriteria).toHaveLength(2);
    expect(data.successCriteria[0].text).toBe("Full test coverage");
    expect(data.successCriteria[1].text).toBe("CI pipeline green");
  });

  it("calculates completionPercentage as 0 when no success criteria exist", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Purpose\n\nJust a purpose, no criteria.\n";
      return "";
    });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.completionPercentage).toBe(0);
  });

  it("calculates completionPercentage as 100 when all criteria completed", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Success Criteria\n\n- [x] Tests passing\n- [x] Docs written\n";
      return "";
    });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.completionPercentage).toBe(100);
  });

  it("calculates completionPercentage rounded for partial completion", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Success Criteria\n\n- [x] First done\n- [ ] Second pending\n- [ ] Third pending\n";
      return "";
    });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.completionPercentage).toBe(33);
  });

  it("cross-references completed.md to mark matching criteria as done", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Success Criteria\n\n- [ ] Add unit tests for handlers\n- [ ] Unrelated criterion\n";
      if (filename === "completed.md") return "| Date | Task | Branch | Notes |\n| --- | --- | --- | --- |\n| 2025-01-15 | Add unit tests for dashboard handlers | feat/tests | Done |";
      return "";
    });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.successCriteria[0].completed).toBe(true);
    expect(data.successCriteria[1].completed).toBe(false);
  });

  it("does not cross-reference when completed.md is empty", async () => {
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return "## Success Criteria\n\n- [ ] Pending item\n";
      if (filename === "completed.md") return "";
      return "";
    });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.successCriteria[0].completed).toBe(false);
  });

  it("returns raw mission.md content in data.raw", async () => {
    const missionContent = "## Purpose\n\nBuild things.\n\n## Goals\n\n1. Ship it\n";
    mockReadDevFile.mockImplementation((_dir, filename) => {
      if (filename === "mission.md") return missionContent;
      return "";
    });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.raw).toBe(missionContent);
  });

  it("returns 500 with error envelope when readDevFile throws", async () => {
    mockReadDevFile.mockImplementation(() => { throw new Error("Permission denied"); });
    const handler = createMissionStatusHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Permission denied");
  });
});
