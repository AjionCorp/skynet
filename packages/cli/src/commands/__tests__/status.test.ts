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

vi.mock("../../utils/sqliteQuery", () => ({
  isSqliteReady: vi.fn(() => false),
  sqliteRows: vi.fn(() => []),
  sqlInt: vi.fn((v: string | number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return 0;
    return n;
  }),
}));

vi.mock("../../utils/isProcessRunning", () => ({
  isProcessRunning: vi.fn(() => ({ running: false, pid: "" })),
}));

import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { statusCommand } from "../status";
import { isSqliteReady, sqliteRows } from "../../utils/sqliteQuery";
import { isProcessRunning } from "../../utils/isProcessRunning";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockIsSqliteReady = vi.mocked(isSqliteReady);
const mockSqliteRows = vi.mocked(sqliteRows);
const mockIsProcessRunning = vi.mocked(isProcessRunning);

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
  let _exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
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

    // Default: SQLite not ready (filesystem fallback)
    mockIsSqliteReady.mockReturnValue(false);
    mockSqliteRows.mockReturnValue([]);
    mockIsProcessRunning.mockReturnValue({ running: false, pid: "" });
  });

  // --- (a) --json flag outputs valid JSON with correct shape ---

  it("--json outputs valid JSON matching the expected shape", async () => {
    await statusCommand({ dir: "/tmp/test-project", json: true });

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
    mockIsSqliteReady.mockReturnValue(true);
    mockSqliteRows.mockImplementation((_devDir, sql) => {
      // Task counts query
      if (sql.includes("SELECT") && sql.includes("c0")) {
        return [["2", "1", "1", "1", "0"]];
      }
      return [];
    });

    await statusCommand({ dir: "/tmp/test-project", json: true });

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
    await statusCommand({ dir: "/tmp/test-project", quiet: true });

    // The only console.log call should be the health score
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    expect(logCalls).toHaveLength(1);
    expect(typeof logCalls[0][0]).toBe("number");
  });

  it("--quiet suppresses all formatted output (no section headers)", async () => {
    await statusCommand({ dir: "/tmp/test-project", quiet: true });
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // Should only have one call: the numeric health score
    expect(logCalls).toHaveLength(1);
    // No section headers like "Tasks:", "Workers:", etc.
    const allOutput = logCalls.flat().join("\n");
    expect(allOutput).not.toContain("Tasks:");
    expect(allOutput).not.toContain("Workers:");
    expect(allOutput).not.toContain("Health Score:");
  });

  // --- (c) health score returns 100 with no failures/blockers/stale heartbeats ---

  it("health score is 100 with no failures, blockers, or stale heartbeats", async () => {
    // No failed tasks, no blockers, no stale heartbeats => score should be 100
    await statusCommand({ dir: "/tmp/test-project", quiet: true });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    expect(logCalls[0][0]).toBe(100);
  });

  // --- (d) health score deductions are correct ---

  it("deducts 5 per pending failure (via SQLite)", async () => {
    mockIsSqliteReady.mockReturnValue(true);
    mockSqliteRows.mockImplementation((_devDir, sql) => {
      // Task counts query - 3 failed pending
      if (sql.includes("c0") && sql.includes("c1")) {
        return [["0", "0", "0", "3", "0"]];
      }
      return [];
    });

    await statusCommand({ dir: "/tmp/test-project", quiet: true });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // 100 - (3 * 5) = 85
    expect(logCalls[0][0]).toBe(85);
  });

  it("deducts 10 per blocker (via SQLite)", async () => {
    mockIsSqliteReady.mockReturnValue(true);
    mockSqliteRows.mockImplementation((_devDir, sql) => {
      // Task counts query
      if (sql.includes("c0") && sql.includes("c1") && sql.includes("c2") && !sql.includes("blockers")) {
        return [["0", "0", "0", "0", "0"]];
      }
      // Blockers/self-correction query
      if (sql.includes("blockers")) {
        return [["2", "0", "0", "0"]]; // 2 blockers
      }
      return [];
    });

    await statusCommand({ dir: "/tmp/test-project", quiet: true });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // 100 - (2 * 10) = 80
    expect(logCalls[0][0]).toBe(80);
  });

  it("deducts 2 per stale heartbeat (via SQLite)", async () => {
    mockIsSqliteReady.mockReturnValue(true);
    mockSqliteRows.mockImplementation((_devDir, sql) => {
      // Task counts query
      if (sql.includes("c0") && sql.includes("c1") && sql.includes("c2") && !sql.includes("blockers") && !sql.includes("heartbeat")) {
        return [["0", "0", "0", "0", "0"]];
      }
      // Heartbeat query
      if (sql.includes("heartbeat")) {
        return [["2", "0"]]; // 2 stale heartbeats
      }
      return [];
    });

    await statusCommand({ dir: "/tmp/test-project", quiet: true });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // 100 - (2 * 2) = 96
    expect(logCalls[0][0]).toBe(96);
  });

  it("combines all health score deductions correctly", async () => {
    mockIsSqliteReady.mockReturnValue(true);
    mockSqliteRows.mockImplementation((_devDir, sql) => {
      // Task counts query - 2 failed pending
      if (sql.includes("c0") && sql.includes("c1") && sql.includes("c2") && !sql.includes("blockers") && !sql.includes("heartbeat")) {
        return [["0", "0", "0", "2", "0"]];
      }
      // Heartbeat query - 1 stale
      if (sql.includes("heartbeat")) {
        return [["1", "0"]];
      }
      // Blockers query - 1 blocker
      if (sql.includes("blockers")) {
        return [["1", "0", "0", "0"]];
      }
      return [];
    });

    await statusCommand({ dir: "/tmp/test-project", quiet: true });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // 100 - (2*5) - (1*10) - (1*2) = 100 - 10 - 10 - 2 = 78
    expect(logCalls[0][0]).toBe(78);
  });

  it("health score is clamped to 0 minimum", async () => {
    mockIsSqliteReady.mockReturnValue(true);
    mockSqliteRows.mockImplementation((_devDir, sql) => {
      // Task counts query
      if (sql.includes("c0") && sql.includes("c1") && sql.includes("c2") && !sql.includes("blockers") && !sql.includes("heartbeat")) {
        return [["0", "0", "0", "0", "0"]];
      }
      // Blockers query - 11 blockers = 110 deduction
      if (sql.includes("blockers")) {
        return [["11", "0", "0", "0"]];
      }
      return [];
    });

    await statusCommand({ dir: "/tmp/test-project", quiet: true });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    expect(logCalls[0][0]).toBe(0);
  });

  // --- (e) worker heartbeat detection loops through all N workers ---

  it("checks heartbeats for all N workers, not just 2 (via SQLite)", async () => {
    const configWith5Workers = makeConfigContent({ SKYNET_MAX_WORKERS: "5" });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return configWith5Workers as never;
      return "" as never;
    });

    mockIsSqliteReady.mockReturnValue(true);
    mockSqliteRows.mockImplementation((_devDir, sql) => {
      // Task counts query
      if (sql.includes("c0") && sql.includes("c1") && sql.includes("c2") && !sql.includes("blockers") && !sql.includes("heartbeat")) {
        return [["0", "0", "0", "0", "0"]];
      }
      // Heartbeat query - 5 stale
      if (sql.includes("heartbeat")) {
        return [["5", "0"]];
      }
      return [];
    });

    await statusCommand({ dir: "/tmp/test-project", quiet: true });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // 100 - (5 * 2) = 90
    expect(logCalls[0][0]).toBe(90);
  });

  it("reads heartbeat files for workers 1 through maxWorkers (via SQLite)", async () => {
    const configWith4Workers = makeConfigContent({ SKYNET_MAX_WORKERS: "4" });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return configWith4Workers as never;
      return "" as never;
    });

    mockIsSqliteReady.mockReturnValue(true);
    mockSqliteRows.mockImplementation((_devDir, sql) => {
      // Task counts query
      if (sql.includes("c0") && sql.includes("c1") && sql.includes("c2") && !sql.includes("blockers") && !sql.includes("heartbeat")) {
        return [["0", "0", "0", "0", "0"]];
      }
      // Heartbeat query - 0 stale (all fresh)
      if (sql.includes("heartbeat")) {
        return [["0", "0"]];
      }
      return [];
    });

    await statusCommand({ dir: "/tmp/test-project", quiet: true });

    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // All heartbeats are fresh => no deduction => 100
    expect(logCalls[0][0]).toBe(100);
  });

  // --- (f) mission progress parsing shows all 6 criteria ---
  // TODO(tech-debt): These mission evaluation tests duplicate the dashboard's
  // mission.test.ts assertions. When the mission evaluation logic is unified
  // (see TODO in status.ts), consolidate these tests to use the shared
  // evaluateMissionCriteria function and only test the CLI-specific adapter.

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
      return "" as never;
    });

    await statusCommand({ dir: "/tmp/test-project", json: true });

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

    // Use SQLite to supply completedCount (criterion 5 needs >= 10)
    mockIsSqliteReady.mockReturnValue(true);
    mockSqliteRows.mockImplementation((_devDir, sql) => {
      // Task counts: 0 pending, 0 claimed, 15 completed, 0 failed, 0 fixed
      if (sql.includes("c0") && sql.includes("c1") && sql.includes("c2") && !sql.includes("blockers") && !sql.includes("heartbeat")) {
        return [["0", "0", "15", "0", "0"]];
      }
      return [];
    });

    await statusCommand({ dir: "/tmp/test-project", json: true });

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

    await statusCommand({ dir: "/tmp/test-project", json: true });

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
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("skynet.config.sh not found"),
    );
  });

  it("self-correction rate calculates correctly (via SQLite)", async () => {
    mockIsSqliteReady.mockReturnValue(true);
    mockSqliteRows.mockImplementation((_devDir, sql) => {
      // Task counts
      if (sql.includes("c0") && sql.includes("c1") && sql.includes("c2") && !sql.includes("blockers") && !sql.includes("heartbeat")) {
        return [["0", "0", "0", "0", "0"]];
      }
      // Blockers/self-correction: 0 blockers, 2 fixed, 1 blocked, 1 superseded
      if (sql.includes("blockers")) {
        return [["0", "2", "1", "1"]];
      }
      return [];
    });

    await statusCommand({ dir: "/tmp/test-project", json: true });

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
