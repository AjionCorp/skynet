import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWorkerScalingHandler } from "./worker-scaling";
import type { SkynetConfig } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  openSync: vi.fn(() => 99),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => false),
  constants: { O_WRONLY: 1, O_CREAT: 64, O_APPEND: 1024 },
}));

import { spawn } from "child_process";
import { readFileSync, openSync, unlinkSync, rmSync, existsSync, writeFileSync } from "fs";

const mockSpawn = vi.mocked(spawn);
const mockReadFileSync = vi.mocked(readFileSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockRmSync = vi.mocked(rmSync);
const mockOpenSync = vi.mocked(openSync);
const mockExistsSync = vi.mocked(existsSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

// We need to mock process.kill to control which PIDs appear "alive"
const _originalProcessKill = process.kill.bind(process);
let alivePids: Set<number> = new Set();

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project",
    devDir: "/tmp/test/.dev",
    lockPrefix: "/tmp/skynet-test",
    workers: [],
    triggerableScripts: [],
    taskTags: [],
    maxWorkers: 4,
    scriptsDir: "/tmp/test/.dev/scripts",
    ...overrides,
  };
}

function makePostRequest(body: unknown): Request {
  return new Request("http://localhost/api/workers/scale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("createWorkerScalingHandler", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.resetAllMocks();
    alivePids = new Set();

    // Default: spawn returns a mock child
    mockSpawn.mockReturnValue({ unref: vi.fn() } as never);
    mockOpenSync.mockReturnValue(99 as never);

    // Mock process.kill to use our alivePids set
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0) {
        // isProcessAlive check
        if (!alivePids.has(pid)) {
          throw new Error("ESRCH: No such process");
        }
        return true;
      }
      // SIGTERM etc — just succeed
      return true;
    });

    // Default: readFileSync for PID files returns nothing (throws ENOENT)
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  // -----------------------------------------------------------------------
  // (1) GET returns current worker counts by type with correct shape
  // -----------------------------------------------------------------------
  describe("GET returns current worker counts with WorkerScaleInfo[] shape", () => {
    it("returns all scalable types with correct shape when no workers running", async () => {
      const { GET } = createWorkerScalingHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data).toHaveProperty("workers");
      expect(Array.isArray(body.data.workers)).toBe(true);
      expect(body.data.workers).toHaveLength(3);

      // Verify each entry matches WorkerScaleInfo shape
      for (const w of body.data.workers) {
        expect(typeof w.type).toBe("string");
        expect(typeof w.label).toBe("string");
        expect(typeof w.count).toBe("number");
        expect(typeof w.maxCount).toBe("number");
        expect(Array.isArray(w.pids)).toBe(true);
      }
    });

    it("returns correct types: dev-worker, task-fixer, project-driver", async () => {
      const { GET } = createWorkerScalingHandler(makeConfig());
      const res = await GET();
      const { data } = await res.json();

      const types = data.workers.map((w: { type: string }) => w.type);
      expect(types).toEqual(["dev-worker", "task-fixer", "project-driver"]);
    });

    it("returns correct labels and maxCounts", async () => {
      const { GET } = createWorkerScalingHandler(makeConfig({ maxWorkers: 4 }));
      const res = await GET();
      const { data } = await res.json();

      const devWorker = data.workers[0];
      expect(devWorker.label).toBe("Dev Worker");
      expect(devWorker.maxCount).toBe(4);

      const taskFixer = data.workers[1];
      expect(taskFixer.label).toBe("Task Fixer");
      expect(taskFixer.maxCount).toBe(3);

      const projectDriver = data.workers[2];
      expect(projectDriver.label).toBe("Project Driver");
      expect(projectDriver.maxCount).toBe(1);
    });

    it("counts running workers by reading PID files", async () => {
      // Simulate dev-worker-1 running with PID 1001
      alivePids.add(1001);
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path) === "/tmp/skynet-test-dev-worker-1.lock") return "1001";
        throw new Error("ENOENT");
      });

      const { GET } = createWorkerScalingHandler(makeConfig());
      const res = await GET();
      const { data } = await res.json();

      const devWorker = data.workers[0];
      expect(devWorker.count).toBe(1);
      expect(devWorker.pids).toEqual([1001]);
    });
  });

  // -----------------------------------------------------------------------
  // (2) POST scale-up returns correct WorkerScaleResult
  // -----------------------------------------------------------------------
  describe("POST scale-up returns correct WorkerScaleResult", () => {
    it("spawns workers and returns correct result shape", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "dev-worker", count: 2 }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      // currentCount reflects actual running workers (from PID lock files),
      // not the requested count. Spawned workers haven't created lock files yet.
      expect(body.data.workerType).toBe("dev-worker");
      expect(body.data.previousCount).toBe(0);
      expect(body.data.maxCount).toBe(4);
      expect(typeof body.data.currentCount).toBe("number");
    });

    it("calls spawn for each new worker", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      await POST(makePostRequest({ workerType: "dev-worker", count: 3 }));

      expect(mockSpawn).toHaveBeenCalledTimes(3);
      // Each call should use bash with the script path
      for (const call of mockSpawn.mock.calls) {
        expect(call[0]).toBe("bash");
        expect(call[1]).toContain("/tmp/test/.dev/scripts/dev-worker.sh");
      }
    });

    it("passes correct instance IDs to spawned workers", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      await POST(makePostRequest({ workerType: "dev-worker", count: 3 }));

      const instanceIds = mockSpawn.mock.calls.map((call) => (call[1] as string[])[1]);
      expect(instanceIds).toEqual(["1", "2", "3"]);
    });

    it("spawns detached processes with SKYNET_DEV_DIR env", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      await POST(makePostRequest({ workerType: "dev-worker", count: 1 }));

      const spawnOpts = mockSpawn.mock.calls[0][2] as { detached: boolean; env: Record<string, string> };
      expect(spawnOpts.detached).toBe(true);
      expect(spawnOpts.env.SKYNET_DEV_DIR).toBe("/tmp/test/.dev");
    });

    it("scales up task-fixer with correct script path", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      await POST(makePostRequest({ workerType: "task-fixer", count: 1 }));

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect((mockSpawn.mock.calls[0][1] as string[])[0]).toBe(
        "/tmp/test/.dev/scripts/task-fixer.sh"
      );
    });
  });

  // -----------------------------------------------------------------------
  // (3) POST scale-down cleans PID files
  // -----------------------------------------------------------------------
  describe("POST scale-down cleans PID files", () => {
    it("kills workers and cleans up lock files", async () => {
      // Simulate 2 running dev-workers
      alivePids.add(1001);
      alivePids.add(1002);
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p === "/tmp/skynet-test-dev-worker-1.lock") return "1001";
        if (p === "/tmp/skynet-test-dev-worker-2.lock") return "1002";
        throw new Error("ENOENT");
      });

      // Remove killed PIDs from alivePids to model real SIGTERM behavior
      vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0) {
          if (!alivePids.has(pid)) throw new Error("ESRCH: No such process");
          return true;
        }
        // SIGTERM — process dies
        alivePids.delete(pid);
        return true;
      });

      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "dev-worker", count: 1 }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.previousCount).toBe(2);
      expect(body.data.currentCount).toBe(1);

      // Should kill highest-numbered worker (worker 2)
      expect(process.kill).toHaveBeenCalledWith(1002, "SIGTERM");

      // P1-15: Lock directory is NOT removed by the dashboard — the worker's
      // EXIT trap owns cleanup. Verify rmSync was NOT called on the lock file.
      expect(mockRmSync).not.toHaveBeenCalledWith(
        "/tmp/skynet-test-dev-worker-2.lock",
        expect.anything()
      );
    });

    it("cleans up heartbeat files for dev-workers on scale-down", async () => {
      alivePids.add(1001);
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path) === "/tmp/skynet-test-dev-worker-1.lock") return "1001";
        throw new Error("ENOENT");
      });

      const { POST } = createWorkerScalingHandler(makeConfig());
      await POST(makePostRequest({ workerType: "dev-worker", count: 0 }));

      // Should clean up heartbeat file
      expect(mockUnlinkSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/worker-1.heartbeat"
      );
    });

    it("kills highest-numbered workers first on scale-down", async () => {
      alivePids.add(1001);
      alivePids.add(1002);
      alivePids.add(1003);
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p === "/tmp/skynet-test-dev-worker-1.lock") return "1001";
        if (p === "/tmp/skynet-test-dev-worker-2.lock") return "1002";
        if (p === "/tmp/skynet-test-dev-worker-3.lock") return "1003";
        throw new Error("ENOENT");
      });

      const { POST } = createWorkerScalingHandler(makeConfig());
      await POST(makePostRequest({ workerType: "dev-worker", count: 1 }));

      // Should kill workers 3 and 2 (highest first), keep worker 1
      const killCalls = (process.kill as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => c[1] === "SIGTERM")
        .map((c: unknown[]) => c[0]);
      expect(killCalls).toContain(1003);
      expect(killCalls).toContain(1002);
      expect(killCalls).not.toContain(1001);
    });
  });

  // -----------------------------------------------------------------------
  // (4) Max worker limit enforced (returns 400)
  // -----------------------------------------------------------------------
  describe("max worker limit enforced", () => {
    it("returns 400 when count exceeds dev-worker maxCount", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig({ maxWorkers: 4 }));
      const res = await POST(makePostRequest({ workerType: "dev-worker", count: 5 }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.data).toBeNull();
      expect(body.error).toContain("count must be an integer between 0 and 4");
    });

    it("returns 400 when count exceeds task-fixer maxCount (3)", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "task-fixer", count: 4 }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("count must be an integer between 0 and 3");
    });

    it("returns 400 when count exceeds project-driver maxCount (1)", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "project-driver", count: 2 }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("count must be an integer between 0 and 1");
    });

    it("returns 400 for negative count", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "dev-worker", count: -1 }));

      expect(res.status).toBe(400);
    });

    it("returns 400 for non-integer count", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "dev-worker", count: 1.5 }));

      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // (5) Invalid worker type returns 400
  // -----------------------------------------------------------------------
  describe("invalid worker type returns 400", () => {
    it("returns 400 for unknown worker type", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "unknown-worker", count: 1 }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.data).toBeNull();
      expect(body.error).toContain("Invalid workerType");
      expect(body.error).toContain("dev-worker, task-fixer, project-driver");
    });

    it("returns 400 for empty workerType", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "", count: 1 }));

      expect(res.status).toBe(400);
    });

    it("returns 400 for workerType with special characters", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "worker;rm -rf /", count: 1 }));

      expect(res.status).toBe(400);
    });

    it("returns 400 for workerType with uppercase", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "Dev-Worker", count: 1 }));

      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // (6) Scale to same count is a no-op
  // -----------------------------------------------------------------------
  describe("scale to same count is a no-op", () => {
    it("does not spawn or kill when count matches current", async () => {
      // Simulate 1 running dev-worker
      alivePids.add(1001);
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path) === "/tmp/skynet-test-dev-worker-1.lock") return "1001";
        throw new Error("ENOENT");
      });

      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "dev-worker", count: 1 }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.previousCount).toBe(1);
      expect(body.data.currentCount).toBe(1);

      // No spawn or SIGTERM should have been called
      expect(mockSpawn).not.toHaveBeenCalled();
      const sigtermCalls = (process.kill as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => c[1] === "SIGTERM");
      expect(sigtermCalls).toHaveLength(0);
    });

    it("is a no-op when scaling 0 to 0", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "dev-worker", count: 0 }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.previousCount).toBe(0);
      expect(body.data.currentCount).toBe(0);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // (7) Handles missing PID files gracefully
  // -----------------------------------------------------------------------
  describe("handles missing PID files gracefully", () => {
    it("GET returns zero count when PID files don't exist", async () => {
      // readFileSync already throws ENOENT by default
      const { GET } = createWorkerScalingHandler(makeConfig());
      const res = await GET();
      const { data } = await res.json();

      expect(res.status).toBe(200);
      for (const w of data.workers) {
        expect(w.count).toBe(0);
        expect(w.pids).toEqual([]);
      }
    });

    it("GET ignores PID files with invalid content", async () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path) === "/tmp/skynet-test-dev-worker-1.lock") return "not-a-number";
        throw new Error("ENOENT");
      });

      const { GET } = createWorkerScalingHandler(makeConfig());
      const res = await GET();
      const { data } = await res.json();

      expect(data.workers[0].count).toBe(0);
    });

    it("GET ignores PID files for dead processes", async () => {
      // PID file exists but process is dead (not in alivePids)
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path) === "/tmp/skynet-test-dev-worker-1.lock") return "99999";
        throw new Error("ENOENT");
      });

      const { GET } = createWorkerScalingHandler(makeConfig());
      const res = await GET();
      const { data } = await res.json();

      expect(data.workers[0].count).toBe(0);
    });

    it("scale-down gracefully handles already-cleaned lock files", async () => {
      alivePids.add(1001);
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path) === "/tmp/skynet-test-dev-worker-1.lock") return "1001";
        throw new Error("ENOENT");
      });
      // rmSync and unlinkSync throw as if files were already deleted
      mockRmSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });
      mockUnlinkSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      // Remove killed PIDs from alivePids to model real SIGTERM behavior
      vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0) {
          if (!alivePids.has(pid)) throw new Error("ESRCH: No such process");
          return true;
        }
        // SIGTERM — process dies
        alivePids.delete(pid);
        return true;
      });

      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "dev-worker", count: 0 }));
      const body = await res.json();

      // Should succeed despite unlink failures
      expect(res.status).toBe(200);
      expect(body.data.previousCount).toBe(1);
      expect(body.data.currentCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // (8) Concurrent scale requests don't corrupt state
  // -----------------------------------------------------------------------
  describe("concurrent scale requests don't corrupt state", () => {
    it("parallel GET requests return consistent data", async () => {
      alivePids.add(1001);
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path) === "/tmp/skynet-test-dev-worker-1.lock") return "1001";
        throw new Error("ENOENT");
      });

      const { GET } = createWorkerScalingHandler(makeConfig());

      // Fire multiple GET requests concurrently
      const results = await Promise.all([GET(), GET(), GET()]);

      for (const res of results) {
        const { data } = await res.json();
        expect(data.workers[0].count).toBe(1);
        expect(data.workers[0].pids).toEqual([1001]);
      }
    });

    it("parallel scale-up requests both complete without error", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());

      const [res1, res2] = await Promise.all([
        POST(makePostRequest({ workerType: "dev-worker", count: 2 })),
        POST(makePostRequest({ workerType: "task-fixer", count: 1 })),
      ]);

      const body1 = await res1.json();
      const body2 = await res2.json();

      expect(body1.error).toBeNull();
      expect(body2.error).toBeNull();
      expect(body1.data.workerType).toBe("dev-worker");
      expect(body2.data.workerType).toBe("task-fixer");
    });

    it("parallel scale requests for same type both return valid results", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());

      const [res1, res2] = await Promise.all([
        POST(makePostRequest({ workerType: "dev-worker", count: 1 })),
        POST(makePostRequest({ workerType: "dev-worker", count: 2 })),
      ]);

      const body1 = await res1.json();
      const body2 = await res2.json();

      // Both should succeed (no 500 errors)
      expect(body1.error).toBeNull();
      expect(body2.error).toBeNull();
      // Both see the same initial state (0 running)
      expect(body1.data.previousCount).toBe(0);
      expect(body2.data.previousCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // (P1-7) Merge lock 409 on scale-down
  // -----------------------------------------------------------------------
  describe("merge lock 409 on scale-down", () => {
    it("returns 409 when worker is currently merging", async () => {
      alivePids.add(1001);
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p === "/tmp/skynet-test-dev-worker-1.lock") return "1001";
        // Simulate merge lock with this worker's PID
        if (p.includes("merge.lock/pid")) return "1001";
        throw new Error("ENOENT");
      });
      // existsSync returns true for merge lock dir and pid file
      mockExistsSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.includes("merge.lock")) return true;
        return false;
      });

      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "dev-worker", count: 0 }));
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.data).toBeNull();
      expect(body.error).toContain("merging");
    });

    it("allows scale-down when merge lock is held by a different PID", async () => {
      alivePids.add(1001);
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p === "/tmp/skynet-test-dev-worker-1.lock") return "1001";
        // Merge lock is held by a different process
        if (p.includes("merge.lock/pid")) return "9999";
        throw new Error("ENOENT");
      });
      mockExistsSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.includes("merge.lock")) return true;
        return false;
      });

      // Remove killed PIDs from alivePids
      vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0) {
          if (!alivePids.has(pid)) throw new Error("ESRCH");
          return true;
        }
        alivePids.delete(pid);
        return true;
      });

      const { POST } = createWorkerScalingHandler(makeConfig());
      const res = await POST(makePostRequest({ workerType: "dev-worker", count: 0 }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // (P1-8) resetStaleTaskFile behavior
  // -----------------------------------------------------------------------
  describe("resetStaleTaskFile on scale-up", () => {
    it("resets stale task file when worker PID is dead", async () => {
      // Worker 1 is dead (PID not in alivePids), but task file has in_progress
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = String(path);
        // No live PID lock — both dir-based and file-based lookups throw
        if (p.includes("dev-worker-1.lock")) throw new Error("ENOENT");
        // Task file has in_progress content
        if (p.includes("current-task-1.md")) return "# Current Task\n**Status:** in_progress\n## Fix auth\n**Branch:** fix/auth";
        throw new Error("ENOENT");
      });

      const { POST } = createWorkerScalingHandler(makeConfig());
      await POST(makePostRequest({ workerType: "dev-worker", count: 1 }));

      // writeFileSync should have been called to reset the task file
      const writeCall = mockWriteFileSync.mock.calls.find(
        (call) => String(call[0]).includes("current-task-1.md")
      );
      expect(writeCall).toBeDefined();
      expect(String(writeCall![1])).toContain("idle");
    });

    it("does not reset task file when worker is alive", async () => {
      alivePids.add(1001);
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = String(path);
        if (p === "/tmp/skynet-test-dev-worker-1.lock") return "1001";
        if (p.includes("current-task-1.md")) return "# Current Task\n**Status:** in_progress";
        throw new Error("ENOENT");
      });

      const { POST } = createWorkerScalingHandler(makeConfig());
      // Scale up to 2 workers (worker 1 alive, worker 2 needs to be spawned)
      await POST(makePostRequest({ workerType: "dev-worker", count: 2 }));

      // writeFileSync should NOT have been called for worker 1's task file
      const writeCall = mockWriteFileSync.mock.calls.find(
        (call) => String(call[0]).includes("current-task-1.md")
      );
      expect(writeCall).toBeUndefined();
    });

    it("does not apply to non-dev-worker types", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      await POST(makePostRequest({ workerType: "task-fixer", count: 1 }));

      // No writeFileSync calls for task files
      const writeCall = mockWriteFileSync.mock.calls.find(
        (call) => String(call[0]).includes("current-task")
      );
      expect(writeCall).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe("error handling", () => {
    it("GET is resilient to process.kill errors (returns 200 with zero counts)", async () => {
      // isProcessAlive catches all errors internally, so GET still succeeds
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw new TypeError("Unexpected error");
      });
      mockReadFileSync.mockReturnValue("1234" as never);

      const { GET } = createWorkerScalingHandler(makeConfig());
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      // All workers show 0 count because isProcessAlive returns false
      for (const w of body.data.workers) {
        expect(w.count).toBe(0);
      }
    });

    it("POST returns 400 on malformed JSON body", async () => {
      const { POST } = createWorkerScalingHandler(makeConfig());
      const badRequest = new Request("http://localhost/api/workers/scale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      const res = await POST(badRequest);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.data).toBeNull();
      expect(typeof body.error).toBe("string");
    });
  });
});
