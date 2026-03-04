import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before importing the route — the events handler uses spawnSync for tail
vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
}));

// Mock fs — the events handler uses appendFileSync for error logging
vi.mock("fs", () => ({
  appendFileSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: Date.now(), ino: 1 })),
}));

// Provide controlled config so tests don't depend on real .dev/ paths
vi.mock("../../../../lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test",
    workers: [],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX"],
  },
}));

import { GET, dynamic } from "./route";
import { spawnSync } from "child_process";

const mockSpawnSync = vi.mocked(spawnSync);

const EPOCH_1 = 1700000000;
const EPOCH_2 = 1700000060;

const SAMPLE_LOG = [
  `${EPOCH_1}|task_completed|Worker 1: finished feat-login`,
  `${EPOCH_2}|task_failed|Worker 2: hit compile error`,
].join("\n");

function mockTailOutput(stdout: string) {
  mockSpawnSync.mockReturnValue({ stdout, stderr: "", status: 0 } as never);
}

describe("/api/admin/events route integration", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.clearAllMocks();
    mockTailOutput(SAMPLE_LOG);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("exports force-dynamic to disable Next.js response caching", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns { data, error } response envelope on success", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("error");
    expect(body.error).toBeNull();
  });

  it("returns parsed events from events.log via tail fallback", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({
      ts: new Date(EPOCH_1 * 1000).toISOString(),
      event: "task_completed",
      detail: "Worker 1: finished feat-login",
    });
    expect(body.data[1]).toMatchObject({
      event: "task_failed",
    });
  });

  it("returns empty array when events.log is empty", async () => {
    mockTailOutput("");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.error).toBeNull();
  });

  it("reads from the configured devDir/events.log path", async () => {
    await GET();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tail",
      ["-100", "/tmp/test/.dev/events.log"],
      expect.any(Object),
    );
  });

  it("skips malformed lines with fewer than 3 parts", async () => {
    mockTailOutput(`${EPOCH_1}|task_completed|Done\nbad_line`);
    const res = await GET();
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].event).toBe("task_completed");
  });

  it("rejects epoch values beyond 4.1e9", async () => {
    mockTailOutput(`4200000000|task_completed|Rejected\n${EPOCH_1}|ok|Valid`);
    const res = await GET();
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].detail).toBe("Valid");
  });

  it("returns 500 with error envelope when both DB and tail fail", async () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("tail not found");
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.data).toBeNull();
    expect(body.error).toBe("tail not found");
  });

  it("returns generic error message in production mode", async () => {
    process.env.NODE_ENV = "production";
    mockSpawnSync.mockImplementation(() => {
      throw new Error("secret details");
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("secret");
  });

  it("extracts worker number from detail field", async () => {
    mockTailOutput(`${EPOCH_1}|task_completed|Worker 3: done`);
    const res = await GET();
    const body = await res.json();

    expect(body.data[0].worker).toBe(3);
  });

  it("preserves pipes in detail field beyond the third part", async () => {
    mockTailOutput(`${EPOCH_1}|task_completed|detail|with|pipes`);
    const res = await GET();
    const body = await res.json();

    expect(body.data[0].detail).toBe("detail|with|pipes");
  });
});
