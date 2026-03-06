import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SkynetConfig } from "../types";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { O_WRONLY: 1, O_CREAT: 64, O_APPEND: 1024 },
}));
vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), pid: 12345 })),
}));
vi.mock("../lib/parse-body", () => ({
  parseBody: vi.fn(async () => ({ data: { action: "pause" }, error: null })),
}));
vi.mock("../lib/process-locks", () => ({
  readPid: vi.fn(() => null),
  isProcessAlive: vi.fn(() => false),
  killByLock: vi.fn(() => false),
  listProjectDriverLocks: vi.fn(() => []),
}));

import { existsSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync } from "fs";
import { spawn } from "child_process";
import { parseBody } from "../lib/parse-body";
import { readPid, isProcessAlive, killByLock, listProjectDriverLocks } from "../lib/process-locks";
import { createPipelineControlHandler } from "./pipeline-control";

const mockExistsSync = vi.mocked(existsSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockOpenSync = vi.mocked(openSync);
const mockCloseSync = vi.mocked(closeSync);
const mockSpawn = vi.mocked(spawn);
const mockParseBody = vi.mocked(parseBody);
const mockReadPid = vi.mocked(readPid);
const mockIsProcessAlive = vi.mocked(isProcessAlive);
const mockKillByLock = vi.mocked(killByLock);
const mockListProjectDriverLocks = vi.mocked(listProjectDriverLocks);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test-",
    workers: [],
    triggerableScripts: [],
    taskTags: ["FEAT", "FIX"],
    ...overrides,
  };
}

function makeRequest(): Request {
  return new Request("http://localhost/api/pipeline/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "pause" }),
  });
}

describe("createPipelineControlHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockParseBody.mockResolvedValue({ data: { action: "pause" }, error: null });
    mockReadPid.mockReturnValue(null);
    mockIsProcessAlive.mockReturnValue(false);
    mockKillByLock.mockReturnValue(false);
    mockListProjectDriverLocks.mockReturnValue([]);
    mockOpenSync.mockReturnValue(42 as never);
    mockSpawn.mockReturnValue({ unref: vi.fn(), pid: 12345 } as never);
  });

  it("returns POST method from factory", () => {
    const handler = createPipelineControlHandler(makeConfig());
    expect(handler).toHaveProperty("POST");
    expect(typeof handler.POST).toBe("function");
  });

  // --- Parse errors ---

  it("returns 400 when body parse fails", async () => {
    mockParseBody.mockResolvedValue({ data: null, error: "Invalid JSON body" });
    const { POST } = createPipelineControlHandler(makeConfig());
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
    expect(body.data).toBeNull();
  });

  it("returns 400 when body is null with no parse error", async () => {
    mockParseBody.mockResolvedValue({ data: null, error: null });
    const { POST } = createPipelineControlHandler(makeConfig());
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.data).toBeNull();
  });

  // --- Pause action ---

  describe("pause action", () => {
    beforeEach(() => {
      mockParseBody.mockResolvedValue({ data: { action: "pause" }, error: null });
    });

    it("creates pause file and returns paused: true", async () => {
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.paused).toBe(true);
      expect(body.data.alreadyPaused).toBeUndefined();
      expect(body.error).toBeNull();
      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const [path, content] = mockWriteFileSync.mock.calls[0];
      expect(path).toContain("pipeline-paused");
      const parsed = JSON.parse(content as string);
      expect(parsed.pausedBy).toBe("dashboard");
      expect(parsed.pausedAt).toBeDefined();
    });

    it("returns alreadyPaused: true when pause file exists", async () => {
      mockExistsSync.mockReturnValue(true);
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.paused).toBe(true);
      expect(body.data.alreadyPaused).toBe(true);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  // --- Resume action ---

  describe("resume action", () => {
    beforeEach(() => {
      mockParseBody.mockResolvedValue({ data: { action: "resume" }, error: null });
    });

    it("removes pause file and returns resumed: true", async () => {
      mockExistsSync.mockReturnValue(true);
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.resumed).toBe(true);
      expect(body.data.alreadyRunning).toBeUndefined();
      expect(body.error).toBeNull();
      expect(mockUnlinkSync).toHaveBeenCalledOnce();
    });

    it("returns alreadyRunning: true when no pause file exists", async () => {
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.resumed).toBe(true);
      expect(body.data.alreadyRunning).toBe(true);
      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });
  });

  // --- Start action ---

  describe("start action", () => {
    beforeEach(() => {
      mockParseBody.mockResolvedValue({ data: { action: "start" }, error: null });
    });

    it("removes pause file if present, spawns watchdog, and returns started: true", async () => {
      // First existsSync call: pauseFile check → true (remove it)
      // Second: watchdogLock check (after readPid returns null) → false
      // Third: scriptPath check → true
      mockExistsSync.mockReturnValueOnce(true)   // pauseFile exists
        .mockReturnValueOnce(false)               // watchdog lock doesn't exist
        .mockReturnValueOnce(true);               // watchdog.sh exists
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.started).toBe(true);
      expect(body.data.alreadyRunning).toBeUndefined();
      expect(body.error).toBeNull();
      expect(mockUnlinkSync).toHaveBeenCalledOnce(); // pause file removed
      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/test/.dev/scripts", { recursive: true });
      expect(mockOpenSync).toHaveBeenCalledOnce();
      expect(mockCloseSync).toHaveBeenCalledOnce();
    });

    it("returns alreadyRunning: true when watchdog is alive", async () => {
      mockReadPid.mockReturnValue(9999);
      mockIsProcessAlive.mockReturnValue(true);
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.started).toBe(true);
      expect(body.data.alreadyRunning).toBe(true);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("proceeds to spawn watchdog even with stale lock", async () => {
      mockReadPid.mockReturnValue(9999);
      mockIsProcessAlive.mockReturnValue(false);
      // existsSync: pauseFile=false, watchdogLock=true (stale), scriptPath=true
      mockExistsSync.mockReturnValueOnce(false)
        .mockReturnValueOnce(true)   // stale lock exists
        .mockReturnValueOnce(true);  // watchdog.sh exists
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.started).toBe(true);
      expect(body.data.alreadyRunning).toBeUndefined();
      expect(mockSpawn).toHaveBeenCalledOnce();
    });

    it("returns 404 when watchdog.sh not found", async () => {
      // existsSync: pauseFile=false, watchdogLock=false, scriptPath=false
      mockExistsSync.mockReturnValue(false);
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(404);
      expect(body.error).toBe("watchdog.sh not found");
      expect(body.data).toBeNull();
    });

    it("uses custom scriptsDir from config", async () => {
      mockExistsSync.mockReturnValueOnce(false)   // pauseFile
        .mockReturnValueOnce(false)                // watchdogLock
        .mockReturnValueOnce(true);                // scriptPath
      const { POST } = createPipelineControlHandler(makeConfig({ scriptsDir: "/custom/scripts" }));
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.started).toBe(true);
      // Verify spawn was called with the custom scripts dir path
      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]![0]).toContain("/custom/scripts/watchdog.sh");
    });

    it("spawns watchdog with correct env vars", async () => {
      mockExistsSync.mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      const config = makeConfig();
      const { POST } = createPipelineControlHandler(config);
      await POST(makeRequest());
      const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string>; detached: boolean };
      expect(spawnOptions.detached).toBe(true);
      expect(spawnOptions.env.SKYNET_DEV_DIR).toBe(config.devDir);
      expect(spawnOptions.env._SKYNET_WATCHDOG_SPAWNED).toBe("1");
    });
  });

  // --- Stop action ---

  describe("stop action", () => {
    beforeEach(() => {
      mockParseBody.mockResolvedValue({ data: { action: "stop" }, error: null });
    });

    it("creates pause file and kills workers, returns stopped: true", async () => {
      mockKillByLock.mockReturnValue(true);
      const { POST } = createPipelineControlHandler(makeConfig({ maxWorkers: 2, maxFixers: 2 }));
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.stopped).toBe(true);
      expect(body.error).toBeNull();
      expect(body.data.killed).toContain("watchdog");
      expect(body.data.killed).toContain("dev-worker-1");
      expect(body.data.killed).toContain("dev-worker-2");
      expect(body.data.killed).toContain("task-fixer-1");
      expect(body.data.killed).toContain("task-fixer-2");
      expect(body.data.killed).toContain("project-driver");
      expect(mockWriteFileSync).toHaveBeenCalledOnce();
    });

    it("does not create pause file if already paused", async () => {
      mockExistsSync.mockReturnValue(true); // pause file already exists
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.stopped).toBe(true);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("returns empty killed array when no workers are running", async () => {
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(body.data.killed).toEqual([]);
    });

    it("kills project-driver locks when listProjectDriverLocks returns entries", async () => {
      mockListProjectDriverLocks.mockReturnValue([
        "/tmp/skynet-test--project-driver-mission-alpha.lock",
        "/tmp/skynet-test--project-driver-mission-beta.lock",
      ]);
      mockKillByLock.mockImplementation((lockPath: string) => {
        return lockPath.includes("project-driver");
      });
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      expect(body.data.stopped).toBe(true);
      // Should have killed the project drivers found via listProjectDriverLocks
      expect(body.data.killed.length).toBeGreaterThanOrEqual(2);
    });

    it("uses default maxWorkers=4 and maxFixers=3 when not configured", async () => {
      mockKillByLock.mockReturnValue(true);
      const { POST } = createPipelineControlHandler(makeConfig());
      const res = await POST(makeRequest());
      const body = await res.json();
      // 1 watchdog + 4 dev-workers + 3 task-fixers + 1 project-driver = 9
      expect(body.data.killed).toHaveLength(9);
    });
  });

  // --- Unknown action ---

  it("returns 400 for unknown action", async () => {
    mockParseBody.mockResolvedValue({ data: { action: "restart" }, error: null });
    const { POST } = createPipelineControlHandler(makeConfig());
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid or missing action");
    expect(body.data).toBeNull();
  });

  it("returns 400 when action is missing", async () => {
    mockParseBody.mockResolvedValue({ data: {}, error: null });
    const { POST } = createPipelineControlHandler(makeConfig());
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Invalid or missing action");
  });

  it("accepts action with mixed case and extra whitespace", async () => {
    mockParseBody.mockResolvedValue({ data: { action: "  StArT  " }, error: null });
    mockExistsSync.mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const { POST } = createPipelineControlHandler(makeConfig());
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  // --- Internal error ---

  it("returns 500 on unexpected error", async () => {
    mockParseBody.mockRejectedValue(new Error("Unexpected failure"));
    const { POST } = createPipelineControlHandler(makeConfig());
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("Unexpected failure");
    expect(body.data).toBeNull();
  });

  it("returns generic error for non-Error throws", async () => {
    mockParseBody.mockRejectedValue("string error");
    const { POST } = createPipelineControlHandler(makeConfig());
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("Internal error");
  });
});
