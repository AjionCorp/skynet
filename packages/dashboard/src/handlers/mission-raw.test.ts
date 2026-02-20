import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMissionRawHandler } from "./mission-raw";
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

describe("createMissionRawHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
  });

  it("returns { data, error: null } envelope on success", async () => {
    const handler = createMissionRawHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toBeDefined();
  });

  it("returns raw mission.md content in data.raw", async () => {
    const missionContent = "## Purpose\n\nBuild the best pipeline.\n\n## Goals\n\n1. Ship it\n";
    mockReadDevFile.mockReturnValue(missionContent);
    const handler = createMissionRawHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.raw).toBe(missionContent);
  });

  it("reads from the correct file (mission.md)", async () => {
    const handler = createMissionRawHandler(makeConfig({ devDir: "/custom/.dev" }));
    await handler();
    expect(mockReadDevFile).toHaveBeenCalledWith("/custom/.dev", "mission.md");
  });

  it("returns empty string in data.raw when mission.md is empty", async () => {
    mockReadDevFile.mockReturnValue("");
    const handler = createMissionRawHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.raw).toBe("");
  });

  it("response shape has only raw key in data", async () => {
    mockReadDevFile.mockReturnValue("some content");
    const handler = createMissionRawHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(Object.keys(data)).toEqual(["raw"]);
  });

  it("returns 500 with error envelope when readDevFile throws", async () => {
    mockReadDevFile.mockImplementation(() => { throw new Error("ENOENT: no such file or directory"); });
    const handler = createMissionRawHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("ENOENT: no such file or directory");
  });

  it("returns generic error message when non-Error is thrown", async () => {
    mockReadDevFile.mockImplementation(() => { throw "unexpected"; });
    const handler = createMissionRawHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Failed to read mission.md");
  });
});
