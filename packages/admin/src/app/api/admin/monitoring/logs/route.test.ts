import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process — tail/grep for log reading
vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
}));

// Mock fs — statSync for file size, readFileSync for log content
vi.mock("fs", () => ({
  statSync: vi.fn(() => ({ size: 0 })),
  readFileSync: vi.fn(() => ""),
}));

// Provide controlled config
vi.mock("../../../../../lib/skynet-config", () => ({
  config: {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test",
    workers: [
      { name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" },
    ],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX"],
  },
}));

import { GET, dynamic } from "./route";
import { spawnSync } from "child_process";
import { statSync } from "fs";

const mockSpawnSync = vi.mocked(spawnSync);
const mockStatSync = vi.mocked(statSync);

function makeRequest(params: Record<string, string>): Request {
  const url = new URL("http://localhost/api/admin/monitoring/logs");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

describe("/api/admin/monitoring/logs route integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSync.mockReturnValue({ stdout: "", stderr: "", status: 0 } as never);
    mockStatSync.mockReturnValue({ size: 0 } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports force-dynamic to disable Next.js response caching", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns { data, error } envelope on success", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "log line\n", stderr: "", status: 0 } as never);
    const res = await GET(makeRequest({ script: "dev-worker-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("error");
    expect(body.error).toBeNull();
  });

  it("returns 400 for invalid script name (allowlist enforced)", async () => {
    const res = await GET(makeRequest({ script: "not-allowed-script" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid script");
  });

  it("returns log data for an allowed script", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "line1\nline2\n", stderr: "", status: 0 } as never);
    mockStatSync.mockReturnValue({ size: 512 } as never);
    const res = await GET(makeRequest({ script: "dev-worker-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.script).toBe("dev-worker-1");
    expect(body.data.lines).toEqual(["line1", "line2"]);
    expect(body.data.fileSizeBytes).toBe(512);
  });

  it("returns empty lines when log file is empty", async () => {
    const res = await GET(makeRequest({ script: "dev-worker-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.error).toBeNull();
    expect(body.data.lines).toEqual([]);
  });

  it("supports search parameter for grep filtering", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "error found\n", stderr: "", status: 0 } as never);
    const res = await GET(makeRequest({ script: "dev-worker-1", search: "error", lines: "50" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "grep",
      expect.arrayContaining(["-i", "error"]),
      expect.any(Object),
    );
  });
});
