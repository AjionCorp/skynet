import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPipelineLogsHandler } from "./pipeline-logs";
import type { SkynetConfig } from "../types";

vi.mock("child_process", () => ({
  spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
}));
vi.mock("fs", () => ({
  statSync: vi.fn(() => ({ size: 0 })),
  openSync: vi.fn(() => 99),
  readSync: vi.fn(() => 0),
  closeSync: vi.fn(),
}));

import { spawnSync } from "child_process";
import { statSync, openSync, readSync, closeSync } from "fs";

const mockSpawnSync = vi.mocked(spawnSync);
const mockStatSync = vi.mocked(statSync);
const mockOpenSync = vi.mocked(openSync);
const mockReadSync = vi.mocked(readSync);
const _mockCloseSync = vi.mocked(closeSync);

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

/**
 * Helper: mock readSync to simulate a file with a given number of newlines.
 * The first call returns a buffer with `lineCount` newline bytes, the second returns 0.
 */
function mockFileWithLines(lineCount: number) {
  let callCount = 0;
  mockReadSync.mockImplementation((_fd: number, buf: NodeJS.ArrayBufferView) => {
    if (callCount++ === 0) {
      // Fill buffer with newlines
      const bytes = buf as unknown as Uint8Array;
      for (let i = 0; i < lineCount && i < bytes.length; i++) {
        bytes[i] = 0x0a; // newline byte
      }
      return Math.min(lineCount, bytes.length);
    }
    return 0; // EOF
  });
}

describe("createPipelineLogsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSync.mockReturnValue({ stdout: "", stderr: "", status: 0 } as never);
    mockStatSync.mockReturnValue({ size: 0 } as never);
    mockOpenSync.mockReturnValue(99 as never);
    mockReadSync.mockReturnValue(0 as never);
  });

  // TEST-P3-2: Ensure test isolation with mock cleanup
  afterEach(() => {
    vi.restoreAllMocks();
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
    mockSpawnSync.mockReturnValue({ stdout: "line1\n", stderr: "", status: 0 } as never);
    mockStatSync.mockReturnValue({ size: 1024 } as never);
    mockOpenSync.mockReturnValue(99 as never);
    // Simulate a file with 3 newline characters
    mockFileWithLines(3);

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

  it("log path always uses devDir/scripts regardless of scriptsDir", async () => {
    const config = makeConfig({ scriptsDir: "/custom/scripts", devDir: "/my/.dev" });
    const handler = createPipelineLogsHandler(config);
    await handler(makeRequest({ script: "dev-worker-1" }));
    const tailCall = mockSpawnSync.mock.calls[0];
    const logPathArg = (tailCall[1] as string[])[(tailCall[1] as string[]).length - 1];
    // Logs always live in devDir/scripts, not scriptsDir
    expect(logPathArg).toContain("/my/.dev/scripts/");
  });

  it("returns count matching the lines param value", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1", lines: "50" }));
    const body = await res.json();
    expect(body.data.count).toBe(50);
  });

  // --- Path traversal defense ---

  it("rejects path traversal via script name with dots/slashes", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    // Attempt directory traversal — script regex rejects non-alphanumeric-hyphen names
    const res = await handler(makeRequest({ script: "../../../etc/passwd" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.data).toBeNull();
  });

  it("rejects script names with slashes", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "foo/bar" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.data).toBeNull();
  });

  it("rejects script names with uppercase or underscores", async () => {
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "Dev_Worker" }));
    const body = await res.json();
    expect(res.status).toBe(400);
  });

  // --- Search sanitization ---

  it("strips shell metacharacters from search input", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "safe result\n", stderr: "", status: 0 } as never);
    const handler = createPipelineLogsHandler(makeConfig());
    // Attempt to inject shell chars — sanitizeSearch strips them
    const res = await handler(makeRequest({ script: "dev-worker-1", search: "error; rm -rf /" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    // Verify grep was called with sanitized string (no semicolons/slashes)
    const grepCall = mockSpawnSync.mock.calls[0];
    const searchArg = (grepCall[1] as string[])[1];
    expect(searchArg).not.toContain(";");
    expect(searchArg).not.toContain("/");
  });

  it("truncates search input to max 100 characters", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "", stderr: "", status: 0 } as never);
    const handler = createPipelineLogsHandler(makeConfig());
    const longSearch = "a".repeat(200);
    await handler(makeRequest({ script: "dev-worker-1", search: longSearch }));
    const grepCall = mockSpawnSync.mock.calls[0];
    const searchArg = (grepCall[1] as string[])[1];
    expect(searchArg.length).toBeLessThanOrEqual(100);
  });

  // --- Error handling for missing files ---

  it("returns empty data when log file does not exist (stat throws)", async () => {
    mockSpawnSync.mockReturnValue({ stdout: "", stderr: "", status: 1 } as never);
    mockStatSync.mockImplementation(() => { throw new Error("ENOENT: no such file"); });
    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.totalLines).toBe(0);
    expect(body.data.fileSizeBytes).toBe(0);
  });

  // --- Size limits ---

  it("reports fileSizeBytes from stat for large files", async () => {
    const largeSizeBytes = 50 * 1024 * 1024; // 50MB
    mockSpawnSync.mockReturnValue({ stdout: "line\n", stderr: "", status: 0 } as never);
    mockStatSync.mockReturnValue({ size: largeSizeBytes } as never);
    mockOpenSync.mockReturnValue(99 as never);
    mockFileWithLines(100000);

    const handler = createPipelineLogsHandler(makeConfig());
    const res = await handler(makeRequest({ script: "dev-worker-1" }));
    const body = await res.json();
    expect(body.data.fileSizeBytes).toBe(largeSizeBytes);
  });
});
