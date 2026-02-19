import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMonitoringLogsHandler } from "./monitoring-logs";
import type { SkynetConfig } from "../types";

vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
}));
vi.mock("fs", () => ({
  statSync: vi.fn(() => ({ size: 0 })),
  readFileSync: vi.fn(() => ""),
}));

import { spawnSync } from "child_process";
import { statSync, readFileSync } from "fs";

const mockSpawnSync = vi.mocked(spawnSync);
const mockStatSync = vi.mocked(statSync);
const mockReadFileSync = vi.mocked(readFileSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: [], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

function makeRequest(params: Record<string, string>): Request {
  const url = new URL("http://localhost/api/monitoring/logs");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

describe("createMonitoringLogsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSync.mockReturnValue({ stdout: "", stderr: "", status: 0 } as never);
    mockStatSync.mockReturnValue({ size: 0 } as never);
    mockReadFileSync.mockReturnValue("");
  });

  it("returns { data, error } envelope shape", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "log line\n", stderr: "", status: 0 } as never);
    const handler = createMonitoringLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("error");
    expect(body.error).toBeNull();
  });

  it("returns 400 for invalid script (allowlist enforced via pipeline-logs)", async () => {
    const handler = createMonitoringLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "not-allowed" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid script");
  });

  it("returns valid log data for an allowed script", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "line1\nline2\n", stderr: "", status: 0 } as never);
    mockStatSync.mockReturnValue({ size: 512 } as never);
    mockReadFileSync.mockReturnValue("line1\nline2\n");
    const handler = createMonitoringLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1" }));
    const body = await res.json();
    expect(body.data.script).toBe("dev-worker-1");
    expect(body.data.lines).toEqual(["line1", "line2"]);
    expect(body.data.fileSizeBytes).toBe(512);
  });

  it("delegates to pipeline-logs handler (accepts same params)", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "match\n", stderr: "", status: 0 } as never);
    const handler = createMonitoringLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1", search: "error", lines: "50" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockSpawnSync).toHaveBeenCalledWith("grep", expect.arrayContaining(["-i", "error"]), expect.any(Object));
    expect(body.data.count).toBe(50);
  });
});
