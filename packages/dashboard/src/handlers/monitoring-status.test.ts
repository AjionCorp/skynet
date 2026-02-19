import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMonitoringStatusHandler } from "./monitoring-status";
import type { SkynetConfig } from "../types";

vi.mock("../lib/file-reader", () => ({
  readDevFile: vi.fn(() => ""),
  getLastLogLine: vi.fn(() => null),
  extractTimestamp: vi.fn(() => null),
}));
vi.mock("../lib/worker-status", () => ({
  getWorkerStatus: vi.fn(() => ({ running: false, pid: null, ageMs: null })),
}));
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  readdirSync: vi.fn(() => []),
}));
vi.mock("child_process", () => ({
  execSync: vi.fn(() => ""),
}));

import { readDevFile, getLastLogLine, extractTimestamp } from "../lib/file-reader";
import { getWorkerStatus } from "../lib/worker-status";
import { existsSync } from "fs";
import { execSync } from "child_process";

const mockReadDevFile = vi.mocked(readDevFile);
const mockGetLastLogLine = vi.mocked(getLastLogLine);
const mockExtractTimestamp = vi.mocked(extractTimestamp);
const mockGetWorkerStatus = vi.mocked(getWorkerStatus);
const mockExistsSync = vi.mocked(existsSync);
const mockExecSync = vi.mocked(execSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: [], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

describe("createMonitoringStatusHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
    mockGetLastLogLine.mockReturnValue(null);
    mockExtractTimestamp.mockReturnValue(null);
    mockGetWorkerStatus.mockReturnValue({ running: false, pid: null, ageMs: null });
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue("" as never);
  });

  it("returns { data, error: null } envelope on success", async () => {
    const handler = createMonitoringStatusHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data).toBeDefined();
  });

  it("includes all expected top-level keys matching PipelineStatus", async () => {
    const handler = createMonitoringStatusHandler(makeConfig());
    const res = await handler();
    const { data } = await res.json();
    expect(data).toHaveProperty("workers");
    expect(data).toHaveProperty("currentTask");
    expect(data).toHaveProperty("backlog");
    expect(data).toHaveProperty("completed");
    expect(data).toHaveProperty("failed");
    expect(data).toHaveProperty("hasBlockers");
    expect(data).toHaveProperty("syncHealth");
    expect(data).toHaveProperty("auth");
    expect(data).toHaveProperty("git");
    expect(data).toHaveProperty("timestamp");
  });

  it("forwards config correctly (workers reflected in response)", async () => {
    const config = makeConfig({
      workers: [
        { name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Worker 1" },
        { name: "dev-worker-2", label: "Dev Worker 2", category: "testing", schedule: "Hourly", description: "Worker 2" },
      ],
    });
    const handler = createMonitoringStatusHandler(config);
    const res = await handler();
    const { data } = await res.json();
    expect(data.workers).toHaveLength(2);
    expect(data.workers[0].name).toBe("dev-worker-1");
    expect(data.workers[1].name).toBe("dev-worker-2");
  });

  it("returns 500 error envelope when underlying handler throws", async () => {
    mockGetWorkerStatus.mockImplementation(() => { throw new Error("Lock corrupted"); });
    const handler = createMonitoringStatusHandler(makeConfig());
    const res = await handler();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Lock corrupted");
  });
});
