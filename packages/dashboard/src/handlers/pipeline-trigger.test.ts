import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPipelineTriggerHandler } from "./pipeline-trigger";
import type { SkynetConfig } from "../types";

const mockUnref = vi.fn();

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ unref: mockUnref })),
}));
vi.mock("fs", () => ({
  openSync: vi.fn(() => 3),
  constants: { O_WRONLY: 1, O_CREAT: 64, O_APPEND: 1024 },
}));

import { spawn } from "child_process";
import { openSync } from "fs";

const mockSpawn = vi.mocked(spawn);
const mockOpenSync = vi.mocked(openSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: ["watchdog", "dev-worker"], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

function makePostRequest(body: unknown): Request {
  return new Request("http://localhost/api/pipeline/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createPipelineTriggerHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnref.mockReset();
  });

  it("returns 400 when script is not in triggerableScripts", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "not-allowed" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.data).toBeNull();
    expect(body.error).toContain("Invalid script");
    expect(body.error).toContain("watchdog");
  });

  it("returns 400 when triggerableScripts is empty", async () => {
    const config = makeConfig({ triggerableScripts: [] });
    const handler = createPipelineTriggerHandler(config);
    const res = await handler(makePostRequest({ script: "watchdog" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid script");
  });

  it("returns 200 with triggered: true for valid script", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "watchdog" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toEqual({ triggered: true, script: "watchdog" });
  });

  it("calls spawn with bash and the script path", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "watchdog" }));
    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([expect.stringContaining("watchdog.sh")]),
      expect.objectContaining({ detached: true }),
    );
  });

  it("calls child.unref() to detach the process", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "watchdog" }));
    expect(mockUnref).toHaveBeenCalled();
  });

  it("returns 400 for invalid arg containing special characters", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "watchdog", args: ["../etc"] }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid argument");
  });

  it("accepts valid alphanumeric args", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "dev-worker", args: ["1"] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.triggered).toBe(true);
  });

  it("passes args to spawn command", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "dev-worker", args: ["2"] }));
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("2");
  });

  it("defaults args to empty array when not provided", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "watchdog" }));
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toHaveLength(1); // just the script path
  });

  it("opens log file for writing", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "watchdog" }));
    expect(mockOpenSync).toHaveBeenCalledWith(
      expect.stringContaining("watchdog.log"),
      expect.any(Number),
    );
  });

  it("uses args[0] as log suffix when args provided", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    await handler(makePostRequest({ script: "dev-worker", args: ["3"] }));
    expect(mockOpenSync).toHaveBeenCalledWith(
      expect.stringContaining("dev-worker-3.log"),
      expect.any(Number),
    );
  });

  it("returns 500 with error message when spawn throws", async () => {
    mockSpawn.mockImplementation(() => { throw new Error("spawn failed"); });
    const handler = createPipelineTriggerHandler(makeConfig());
    const res = await handler(makePostRequest({ script: "watchdog" }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("spawn failed");
  });

  it("returns 400 when request body is not valid JSON", async () => {
    const handler = createPipelineTriggerHandler(makeConfig());
    const req = new Request("http://localhost/api/pipeline/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await handler(req);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.data).toBeNull();
    expect(body.error).toBeTruthy();
  });
});
