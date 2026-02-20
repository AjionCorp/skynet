import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ mtime: new Date(), mtimeMs: Date.now(), isDirectory: () => false })),
  readdirSync: vi.fn(() => []),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
}));

import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { statusCommand } from "../status";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockExecSync = vi.mocked(execSync);

/** Build a valid config file content with all required vars. */
function makeConfigContent(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    SKYNET_PROJECT_NAME: "test-project",
    SKYNET_PROJECT_DIR: "/tmp/test-project",
    SKYNET_DEV_DIR: "/tmp/test-project/.dev",
    SKYNET_LOCK_PREFIX: "/tmp/skynet-test-project",
    SKYNET_MAX_WORKERS: "2",
  };
  const vars = { ...defaults, ...overrides };
  return Object.entries(vars)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join("\n");
}

const MISSION_WITH_6_CRITERIA = `# Mission

## Success Criteria
1. Dashboard API coverage — at least 5 handlers
2. Self-correction rate above 95%
3. No zombie/deadlock issues in watchdog
4. Full dashboard API — at least 8 handlers
5. Task throughput — at least 10 completed
6. Agent plugins — at least 2 agents
`;

describe("statusCommand", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default: config exists, everything else doesn't
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      return "" as never;
    });

    mockReaddirSync.mockReturnValue([] as never);

    mockStatSync.mockReturnValue({
      mtime: new Date(),
      mtimeMs: Date.now(),
      isDirectory: () => false,
    } as never);

    // execSync: make kill -0 always fail (no running workers)
    mockExecSync.mockImplementation(() => {
      throw new Error("no such process");
    });
  });

  // --- (a) --json flag outputs valid JSON with correct shape ---

  it("--json outputs valid JSON matching the expected shape", async () => {
    await expect(
      statusCommand({ dir: "/tmp/test-project", json: true }),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(0);

    // Find the console.log call with JSON output
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    const jsonCall = logCalls.find((c) => {
      try {
        JSON.parse(String(c[0]));
        return true;
      } catch {
        return false;
      }
    });

    expect(jsonCall).toBeDefined();
    const data = JSON.parse(String(jsonCall![0]));

    // Verify all top-level keys exist
    expect(data).toHaveProperty("project", "test-project");
    expect(data).toHaveProperty("paused");
    expect(data).toHaveProperty("tasks");
    expect(data).toHaveProperty("workers");
    expect(data).toHaveProperty("healthScore");
    expect(data).toHaveProperty("selfCorrectionRate");
    expect(data).toHaveProperty("missionProgress");
    expect(data).toHaveProperty("lastActivity");

    // Verify tasks sub-shape
    expect(data.tasks).toHaveProperty("pending");
    expect(data.tasks).toHaveProperty("claimed");
    expect(data.tasks).toHaveProperty("completed");
    expect(data.tasks).toHaveProperty("failed");
  });

  it("--json includes correct task counts", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      if (path.endsWith("backlog.md"))
        return "- [ ] Task 1\n- [ ] Task 2\n- [>] Claimed task\n" as never;
      if (path.endsWith("completed.md"))
        return "| Date | Task | Branch | Notes |\n|------|------|--------|-------|\n| 2026-01-01 | Done task | dev/done | OK |\n" as never;
      if (path.endsWith("failed-tasks.md"))
        return "| Date | Task | Branch | Error | Worker | Status |\n|------|------|--------|-------|--------|--------|\n| 2026-01-01 | Fail1 | dev/f1 | err | 1 | pending |\n" as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", json: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    const jsonCall = logCalls.find((c) => {
      try {
        JSON.parse(String(c[0]));
        return true;
      } catch {
        return false;
      }
    });
    const data = JSON.parse(String(jsonCall![0]));

    expect(data.tasks.pending).toBe(2);
    expect(data.tasks.claimed).toBe(1);
    expect(data.tasks.completed).toBe(1);
    expect(data.tasks.failed).toBe(1);
  });

  // --- (b) --quiet flag outputs only the health score number ---

  it("--quiet outputs only the health score number", async () => {
    await expect(
      statusCommand({ dir: "/tmp/test-project", quiet: true }),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(0);

    // The only console.log call should be the health score
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    expect(logCalls).toHaveLength(1);
    expect(typeof logCalls[0][0]).toBe("number");
  });

  // --- (c) health score returns 100 with no failures/blockers/stale heartbeats ---

  it("health score is 100 with no failures, blockers, or stale heartbeats", async () => {
    // No failed tasks, no blockers, no stale heartbeats => score should be 100
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      if (path.endsWith("blockers.md")) return "No active blockers" as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", quiet: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    expect(logCalls[0][0]).toBe(100);
  });

  // --- (d) health score deductions are correct ---

  it("deducts 5 per pending failure", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      if (path.endsWith("failed-tasks.md"))
        return "| pending |\n| pending |\n| pending |\n" as never;
      if (path.endsWith("blockers.md")) return "No active blockers" as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", quiet: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // 100 - (3 * 5) = 85
    expect(logCalls[0][0]).toBe(85);
  });

  it("deducts 10 per blocker", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      if (path.endsWith("blockers.md"))
        return "- Blocker one\n- Blocker two\n" as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", quiet: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // 100 - (2 * 10) = 80
    expect(logCalls[0][0]).toBe(80);
  });

  it("deducts 2 per stale heartbeat", async () => {
    const staleEpoch = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000); // 2 hours ago

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("worker-1.heartbeat")) return true;
      if (path.endsWith("worker-2.heartbeat")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      if (path.endsWith("worker-1.heartbeat")) return String(staleEpoch) as never;
      if (path.endsWith("worker-2.heartbeat")) return String(staleEpoch) as never;
      if (path.endsWith("blockers.md")) return "No active blockers" as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", quiet: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // 100 - (2 * 2) = 96
    expect(logCalls[0][0]).toBe(96);
  });

  it("combines all health score deductions correctly", async () => {
    const staleEpoch = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("worker-1.heartbeat")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      if (path.endsWith("failed-tasks.md"))
        return "| pending |\n| pending |\n" as never; // 2 pending failures
      if (path.endsWith("blockers.md"))
        return "- Blocker one\n" as never; // 1 blocker
      if (path.endsWith("worker-1.heartbeat")) return String(staleEpoch) as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", quiet: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // 100 - (2*5) - (1*10) - (1*2) = 100 - 10 - 10 - 2 = 78
    expect(logCalls[0][0]).toBe(78);
  });

  it("health score is clamped to 0 minimum", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      // 10 blockers = -100 deduction, should clamp to 0
      if (path.endsWith("blockers.md"))
        return "- B1\n- B2\n- B3\n- B4\n- B5\n- B6\n- B7\n- B8\n- B9\n- B10\n- B11\n" as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", quiet: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    expect(logCalls[0][0]).toBe(0);
  });

  // --- (e) worker heartbeat detection loops through all N workers ---

  it("checks heartbeats for all N workers, not just 2", async () => {
    const configWith5Workers = makeConfigContent({ SKYNET_MAX_WORKERS: "5" });
    const staleEpoch = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      // All 5 workers have stale heartbeats
      if (path.match(/worker-[1-5]\.heartbeat$/)) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return configWith5Workers as never;
      if (path.match(/worker-[1-5]\.heartbeat$/)) return String(staleEpoch) as never;
      if (path.endsWith("blockers.md")) return "No active blockers" as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", quiet: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // 100 - (5 * 2) = 90  (all 5 heartbeats are stale)
    expect(logCalls[0][0]).toBe(90);
  });

  it("reads heartbeat files for workers 1 through maxWorkers", async () => {
    const configWith4Workers = makeConfigContent({ SKYNET_MAX_WORKERS: "4" });
    const freshEpoch = Math.floor(Date.now() / 1000); // fresh heartbeat

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.match(/worker-[1-4]\.heartbeat$/)) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return configWith4Workers as never;
      if (path.match(/worker-[1-4]\.heartbeat$/)) return String(freshEpoch) as never;
      if (path.endsWith("blockers.md")) return "No active blockers" as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", quiet: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // All heartbeats are fresh => no deduction => 100
    expect(logCalls[0][0]).toBe(100);

    // Verify existsSync was called for all 4 worker heartbeats
    const existsCalls = mockExistsSync.mock.calls.map((c) => String(c[0]));
    for (let i = 1; i <= 4; i++) {
      expect(existsCalls.some((p) => p.includes(`worker-${i}.heartbeat`))).toBe(true);
    }
  });

  // --- (f) mission progress parsing shows all 6 criteria ---

  it("parses all 6 mission criteria in --json output", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      if (path.endsWith("mission.md")) return MISSION_WITH_6_CRITERIA as never;
      if (path.endsWith("blockers.md")) return "No active blockers" as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", json: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    const jsonCall = logCalls.find((c) => {
      try {
        JSON.parse(String(c[0]));
        return true;
      } catch {
        return false;
      }
    });
    const data = JSON.parse(String(jsonCall![0]));

    // All 6 criteria should be present
    expect(data.missionProgress).toHaveLength(6);

    // Each criterion should have the expected shape
    for (const criterion of data.missionProgress) {
      expect(criterion).toHaveProperty("id");
      expect(criterion).toHaveProperty("criterion");
      expect(criterion).toHaveProperty("status");
      expect(criterion).toHaveProperty("evidence");
      expect(["met", "partial", "not-met"]).toContain(criterion.status);
    }

    // Verify criterion IDs 1 through 6
    const ids = data.missionProgress.map((c: { id: number }) => c.id);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("mission criteria correctly evaluate met/partial/not-met statuses", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      // handlers dir exists
      if (path.includes("packages/dashboard/src/handlers")) return true;
      // agents dir exists
      if (path.includes("scripts/agents")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      if (path.endsWith("mission.md")) return MISSION_WITH_6_CRITERIA as never;
      if (path.endsWith("blockers.md")) return "No active blockers" as never;
      // completed.md with 15 completed tasks to trigger criterion 5 = met
      if (path.endsWith("completed.md")) {
        const header = "| Date | Task | Branch | Notes |\n|------|------|--------|-------|\n";
        const rows = Array.from({ length: 15 }, (_, i) =>
          `| 2026-01-${String(i + 1).padStart(2, "0")} | Task ${i + 1} | dev/t${i + 1} | OK |`
        ).join("\n");
        return (header + rows) as never;
      }
      // watchdog.log with no issues => criterion 3 = met
      if (path.endsWith("watchdog.log")) return "All OK\n" as never;
      return "" as never;
    });

    // 10 handler files => criteria 1 met (>=5), criteria 4 met (>=8)
    // 3 agent files => criterion 6 met (>=2)
    mockReaddirSync.mockImplementation((p) => {
      const path = String(p);
      if (path.includes("packages/dashboard/src/handlers")) {
        return [
          "tasks.ts", "workers.ts", "health.ts", "events.ts", "config.ts",
          "blockers.ts", "metrics.ts", "auth.ts", "pipeline.ts", "status.ts",
        ] as never;
      }
      if (path.includes("scripts/agents")) {
        return ["agent-a.sh", "agent-b.sh", "agent-c.sh"] as never;
      }
      return [] as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", json: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    const jsonCall = logCalls.find((c) => {
      try {
        JSON.parse(String(c[0]));
        return true;
      } catch {
        return false;
      }
    });
    const data = JSON.parse(String(jsonCall![0]));

    // Criterion 1: >= 5 handlers => met
    expect(data.missionProgress[0].status).toBe("met");
    // Criterion 2: no failures resolved yet => partial
    expect(data.missionProgress[1].status).toBe("partial");
    // Criterion 3: no zombie/deadlock => met
    expect(data.missionProgress[2].status).toBe("met");
    // Criterion 4: >= 8 handlers => met
    expect(data.missionProgress[3].status).toBe("met");
    // Criterion 5: >= 10 completed => met
    expect(data.missionProgress[4].status).toBe("met");
    // Criterion 6: >= 2 agents => met
    expect(data.missionProgress[5].status).toBe("met");
  });

  // --- Additional edge cases ---

  it("shows paused status when pipeline-paused file exists", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("pipeline-paused")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      if (path.endsWith("pipeline-paused"))
        return JSON.stringify({ pausedAt: "2026-02-20", pausedBy: "user" }) as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", json: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    const jsonCall = logCalls.find((c) => {
      try {
        JSON.parse(String(c[0]));
        return true;
      } catch {
        return false;
      }
    });
    const data = JSON.parse(String(jsonCall![0]));
    expect(data.paused).toBe(true);
  });

  it("throws when config file is missing", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(
      statusCommand({ dir: "/tmp/test-project" }),
    ).rejects.toThrow("skynet.config.sh not found");
  });

  it("self-correction rate calculates correctly", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return makeConfigContent() as never;
      if (path.endsWith("failed-tasks.md")) {
        return [
          "| Date | Task | Branch | Error | Worker | Status |",
          "|------|------|--------|-------|--------|--------|",
          "| 2026-01-01 | T1 | dev/t1 | err | 1 | fixed |",
          "| 2026-01-02 | T2 | dev/t2 | err | 2 | fixed |",
          "| 2026-01-03 | T3 | dev/t3 | err | 1 | blocked |",
          "| 2026-01-04 | T4 | dev/t4 | err | 2 | superseded |",
        ].join("\n") as never;
      }
      if (path.endsWith("blockers.md")) return "No active blockers" as never;
      return "" as never;
    });

    await expect(
      statusCommand({ dir: "/tmp/test-project", json: true }),
    ).rejects.toThrow("process.exit");

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    const jsonCall = logCalls.find((c) => {
      try {
        JSON.parse(String(c[0]));
        return true;
      } catch {
        return false;
      }
    });
    const data = JSON.parse(String(jsonCall![0]));

    // fixed=2, superseded=1, blocked=1 => selfCorrected=3, resolved=4
    // rate = round(3/4 * 100) = 75
    expect(data.selfCorrectionRate).toBe(75);
  });
});
