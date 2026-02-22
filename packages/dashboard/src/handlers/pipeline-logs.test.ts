import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPipelineLogsHandler } from "./pipeline-logs";
import type { SkynetConfig } from "../types";

vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
}));
vi.mock("fs", () => ({
  statSync: vi.fn(() => ({ size: 0 })),
}));

import { spawnSync } from "child_process";
import { statSync } from "fs";

const mockSpawnSync = vi.mocked(spawnSync);
const mockStatSync = vi.mocked(statSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: [], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

function makeRequest(params: Record<string, string>): Request {
  const url = new URL("http://localhost/api/pipeline/logs");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

describe("createPipelineLogsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSync.mockReturnValue({ stdout: "", stderr: "", status: 0 } as never);
    mockStatSync.mockReturnValue({ size: 0 } as never);
  });

  it("returns 400 when script param is missing", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({}));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.data).toBeNull();
    expect(body.error).toContain("Invalid script");
  });

  it("returns 400 when script is not in allowlist", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "malicious-script" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid script");
  });

  it("returns 200 with data envelope for allowed worker name", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "line1\nline2\n", stderr: "", status: 0 } as never);
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data.script).toBe("dev-worker-1");
    expect(body.data.lines).toEqual(["line1", "line2"]);
  });

  it("allows built-in post-commit-gate script", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "post-commit-gate" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.script).toBe("post-commit-gate");
  });

  it("allows built-in dev-worker script", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.script).toBe("dev-worker");
  });

  it("allows worker logFile override in allowlist", async () => {
    const config = makeConfig({
      workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks", logFile: "custom-log" }],
    });
    const handler = createPipelineLogsHandler(config);
    const res = await handler(makeRequest({ script: "custom-log" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.script).toBe("custom-log");
  });

  it("defaults lines to 200", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    await handler(makeRequest({ script: "dev-worker-1" }));
    const tailCall = mockSpawnSync.mock.calls[0];
    expect(tailCall[0]).toBe("tail");
    expect(tailCall[1]).toContain("200");
  });

  it("clamps lines to max 1000", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    await handler(makeRequest({ script: "dev-worker-1", lines: "5000" }));
    const tailCall = mockSpawnSync.mock.calls[0];
    expect(tailCall[1]).toContain("1000");
  });

  it("clamps lines to min 1", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    await handler(makeRequest({ script: "dev-worker-1", lines: "-10" }));
    const tailCall = mockSpawnSync.mock.calls[0];
    expect(tailCall[1]).toContain("1");
  });

  it("uses tail when no search param provided", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "log line 1\nlog line 2\n", stderr: "", status: 0 } as never);
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1" }));
    const body = await res.json();
    expect(mockSpawnSync).toHaveBeenCalledWith("tail", expect.any(Array), expect.any(Object));
    expect(body.data.lines).toEqual(["log line 1", "log line 2"]);
  });

  it("uses grep -i when search param provided", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "matching line\n", stderr: "", status: 0 } as never);
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1", search: "error" }));
    const body = await res.json();
    expect(mockSpawnSync).toHaveBeenCalledWith("grep", expect.arrayContaining(["-i", "error"]), expect.any(Object));
    expect(body.data.lines).toEqual(["matching line"]);
  });

  it("returns empty lines when sanitized search is empty", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1", search: "!!!@@@" }));
    const body = await res.json();
    expect(body.data.lines).toEqual([]);
    expect(body.data.totalLines).toBe(0);
  });

  it("populates totalLines and fileSizeBytes from stat/wc", async () => {
    mockSpawnSync
      .mockReturnValueOnce({ stdout: "line1\n", stderr: "", status: 0 } as never)  // tail
      .mockReturnValueOnce({ stdout: "       3 /path/to/file.log\n", stderr: "", status: 0 } as never);  // wc -l
    mockStatSync.mockReturnValue({ size: 1024 } as never);
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1" }));
    const body = await res.json();
    expect(body.data.fileSizeBytes).toBe(1024);
    expect(body.data.totalLines).toBe(3);
  });

  it("returns empty data (not 500) when spawnSync throws", async () => {
    mockSpawnSync.mockImplementation(() => { throw new Error("spawn failed"); });
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.lines).toEqual([]);
    expect(body.data.script).toBe("dev-worker-1");
    expect(body.error).toBeNull();
  });

  it("uses config.scriptsDir override when set", async () => {
    const config = makeConfig({ scriptsDir: "/custom/scripts" });
    const handler = createPipelineLogsHandler(config);
    await handler(makeRequest({ script: "dev-worker-1" }));
    const tailCall = mockSpawnSync.mock.calls[0];
    const logPathArg = (tailCall[1] as string[])[(tailCall[1] as string[]).length - 1];
    expect(logPathArg).toContain("/custom/scripts/");
  });

  it("returns count matching the lines param value", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1", lines: "50" }));
    const body = await res.json();
    expect(body.data.count).toBe(50);
  });
});
