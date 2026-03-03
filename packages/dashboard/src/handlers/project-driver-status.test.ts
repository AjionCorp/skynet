import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProjectDriverStatusHandler } from "./project-driver-status";
import type { SkynetConfig } from "../types";

vi.mock("../lib/file-reader", () => ({
  readDevFile: vi.fn(() => ""),
  getLastLogLine: vi.fn(() => null),
  extractTimestamp: vi.fn(() => null),
}));
vi.mock("../lib/worker-status", () => ({
  getWorkerStatus: vi.fn(() => ({ running: false, pid: null, ageMs: null })),
}));

import { readDevFile, getLastLogLine, extractTimestamp } from "../lib/file-reader";
import { getWorkerStatus } from "../lib/worker-status";

const mockReadDevFile = vi.mocked(readDevFile);
const mockGetLastLogLine = vi.mocked(getLastLogLine);
const mockExtractTimestamp = vi.mocked(extractTimestamp);
const mockGetWorkerStatus = vi.mocked(getWorkerStatus);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: [], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

describe("createProjectDriverStatusHandler", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
    mockGetLastLogLine.mockReturnValue(null);
    mockExtractTimestamp.mockReturnValue(null);
    mockGetWorkerStatus.mockReturnValue({ running: false, pid: null, ageMs: null });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("returns { data, error: null } envelope on success", async () => {
    const handler = createProjectDriverStatusHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toBeDefined();
  });

  it("includes all expected keys matching ProjectDriverStatus", async () => {
    const handler = createProjectDriverStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data).toHaveProperty("running");
    expect(data).toHaveProperty("pid");
    expect(data).toHaveProperty("ageMs");
    expect(data).toHaveProperty("lastLog");
    expect(data).toHaveProperty("lastLogTime");
    expect(data).toHaveProperty("telemetry");
  });

  it("builds lock file path from config lockPrefix", async () => {
    const handler = createProjectDriverStatusHandler(makeConfig({ lockPrefix: "/tmp/skynet-myproj-" }));
    await handler();
    expect(mockGetWorkerStatus).toHaveBeenCalledWith("/tmp/skynet-myproj--project-driver.lock");
  });

  it("returns running state when worker is active", async () => {
    mockGetWorkerStatus.mockReturnValue({ running: true, pid: 12345, ageMs: 60000 });
    const handler = createProjectDriverStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.running).toBe(true);
    expect(data.pid).toBe(12345);
    expect(data.ageMs).toBe(60000);
  });

  it("returns stopped state when worker is inactive", async () => {
    const handler = createProjectDriverStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.running).toBe(false);
    expect(data.pid).toBeNull();
    expect(data.ageMs).toBeNull();
  });

  it("returns last log line and extracted timestamp", async () => {
    mockGetLastLogLine.mockReturnValue("[2026-03-03 10:00:00] Cycle complete");
    mockExtractTimestamp.mockReturnValue("2026-03-03 10:00:00");
    const handler = createProjectDriverStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.lastLog).toBe("[2026-03-03 10:00:00] Cycle complete");
    expect(data.lastLogTime).toBe("2026-03-03 10:00:00");
  });

  it("passes devDir and script name to getLastLogLine", async () => {
    const handler = createProjectDriverStatusHandler(makeConfig({ devDir: "/custom/.dev" }));
    await handler();
    expect(mockGetLastLogLine).toHaveBeenCalledWith("/custom/.dev", "project-driver");
  });

  it("parses valid telemetry JSON", async () => {
    const telemetry = {
      pendingBacklog: 5, claimedBacklog: 2, pendingRetries: 1,
      fixRate: 0.75, duplicateSkipped: 3, maxNewTasks: 10,
      driver_low_fix_rate_mode: false, ts: "2026-03-03T10:00:00Z",
    };
    mockReadDevFile.mockReturnValue(JSON.stringify(telemetry));
    const handler = createProjectDriverStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.telemetry).toEqual(telemetry);
  });

  it("returns null telemetry when file is empty", async () => {
    mockReadDevFile.mockReturnValue("");
    const handler = createProjectDriverStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data.telemetry).toBeNull();
  });

  it("returns null telemetry when JSON is malformed", async () => {
    mockReadDevFile.mockReturnValue("{not valid json");
    const handler = createProjectDriverStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(res.status).toBe(200);
    expect(data.telemetry).toBeNull();
  });

  it("reads telemetry from correct file path", async () => {
    const handler = createProjectDriverStatusHandler(makeConfig({ devDir: "/my/.dev" }));
    await handler();
    expect(mockReadDevFile).toHaveBeenCalledWith("/my/.dev", "project-driver-telemetry.json");
  });

  it("returns 500 with error message in development mode", async () => {
    mockGetWorkerStatus.mockImplementation(() => { throw new Error("Lock corrupted"); });
    const handler = createProjectDriverStatusHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Lock corrupted");
  });

  it("returns 500 with generic message in production mode", async () => {
    process.env.NODE_ENV = "production";
    mockGetWorkerStatus.mockImplementation(() => { throw new Error("Lock corrupted"); });
    const handler = createProjectDriverStatusHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Internal server error");
  });

  it("returns 'Internal error' for non-Error thrown values in dev mode", async () => {
    mockGetWorkerStatus.mockImplementation(() => { throw "string error"; });
    const handler = createProjectDriverStatusHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("Internal error");
  });
});
