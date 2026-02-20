import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
}));

import { readFileSync, existsSync } from "fs";
import { metricsCommand } from "../metrics";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);

const CONFIG_CONTENT =
  'export SKYNET_PROJECT_NAME="test-project"\nexport SKYNET_PROJECT_DIR="/tmp/test"\nexport SKYNET_DEV_DIR="/tmp/test/.dev"';

const COMPLETED_HEADER = `| Date | Task | Branch | Duration | Notes |
| --- | --- | --- | --- | --- |`;

const FAILED_HEADER = `| Date | Task | Branch | Status | Notes |
| --- | --- | --- | --- | --- |`;

function makeCompleted(rows: string[]): string {
  return COMPLETED_HEADER + "\n" + rows.join("\n") + "\n";
}

function makeFailed(rows: string[]): string {
  return FAILED_HEADER + "\n" + rows.join("\n") + "\n";
}

describe("metricsCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      return false;
    });
  });

  function setupFiles(completed: string, failed: string) {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("completed.md")) return completed as never;
      if (path.endsWith("failed-tasks.md")) return failed as never;
      return "" as never;
    });
  }

  function getLogOutput(): string {
    return logSpy.mock.calls.flat().join("\n");
  }

  // ──────────────────────────────────────────
  // Duration parsing
  // ──────────────────────────────────────────

  describe("duration parsing", () => {
    it("parses 'Nm' format correctly", async () => {
      setupFiles(
        makeCompleted([
          "| 2026-01-01 | [FEAT] Task A | branch-a | 3m | done |",
          "| 2026-01-02 | [FEAT] Task B | branch-b | 7m | done |",
        ]),
        makeFailed([]),
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      // Average of 3m and 7m = 5m
      expect(output).toContain("Average duration:");
      expect(output).toContain("5m");
    });

    it("parses 'Nh Mm' format correctly", async () => {
      setupFiles(
        makeCompleted([
          "| 2026-01-01 | [FEAT] Task A | branch-a | 1h 12m | done |",
        ]),
        makeFailed([]),
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      // 1h 12m = 72 minutes → "1h 12m"
      expect(output).toContain("1h 12m");
    });

    it("handles '0m' duration", async () => {
      setupFiles(
        makeCompleted([
          "| 2026-01-01 | [FEAT] Task A | branch-a | 0m | done |",
        ]),
        makeFailed([]),
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      // 0 minutes → "< 1m"
      expect(output).toContain("< 1m");
    });

    it("computes average across mixed duration formats", async () => {
      setupFiles(
        makeCompleted([
          "| 2026-01-01 | [FEAT] Task A | branch-a | 1h 0m | done |",
          "| 2026-01-02 | [FIX] Task B | branch-b | 30m | done |",
          "| 2026-01-03 | [TEST] Task C | branch-c | 30m | done |",
        ]),
        makeFailed([]),
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      // (60 + 30 + 30) / 3 = 40m
      expect(output).toContain("40m");
    });

    it("computes tasks per hour correctly", async () => {
      setupFiles(
        makeCompleted([
          "| 2026-01-01 | [FEAT] Task A | branch-a | 30m | done |",
          "| 2026-01-02 | [FEAT] Task B | branch-b | 30m | done |",
        ]),
        makeFailed([]),
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      // 2 tasks / (60min / 60) = 2.0 tasks/hour
      expect(output).toContain("Tasks per hour:");
      expect(output).toContain("2.0");
    });
  });

  // ──────────────────────────────────────────
  // Tag breakdown
  // ──────────────────────────────────────────

  describe("tag breakdown calculation", () => {
    it("counts each tag type correctly", async () => {
      setupFiles(
        makeCompleted([
          "| 2026-01-01 | [FEAT] Feature one | b1 | 5m | done |",
          "| 2026-01-02 | [FEAT] Feature two | b2 | 5m | done |",
          "| 2026-01-03 | [FIX] Bug fix | b3 | 5m | done |",
          "| 2026-01-04 | [TEST] Unit tests | b4 | 5m | done |",
          "| 2026-01-05 | [INFRA] CI setup | b5 | 5m | done |",
          "| 2026-01-06 | [DOCS] Readme | b6 | 5m | done |",
        ]),
        makeFailed([]),
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      expect(output).toContain("Total completed:     6");
      // [FEAT] = 2 → 33%
      expect(output).toMatch(/\[FEAT\]\s+2\s+33%/);
      // [FIX] = 1 → 17%
      expect(output).toMatch(/\[FIX\]\s+1\s+17%/);
      // [TEST] = 1 → 17%
      expect(output).toMatch(/\[TEST\]\s+1\s+17%/);
      // [INFRA] = 1 → 17%
      expect(output).toMatch(/\[INFRA\]\s+1\s+17%/);
      // [DOCS] = 1 → 17%
      expect(output).toMatch(/\[DOCS\]\s+1\s+17%/);
    });

    it("shows 'Other' for untagged tasks", async () => {
      setupFiles(
        makeCompleted([
          "| 2026-01-01 | [FEAT] Tagged | b1 | 5m | done |",
          "| 2026-01-02 | No tag here | b2 | 5m | done |",
        ]),
        makeFailed([]),
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      expect(output).toContain("Other");
      expect(output).toMatch(/Other\s+1\s+50%/);
    });
  });

  // ──────────────────────────────────────────
  // Fix success rate
  // ──────────────────────────────────────────

  describe("fix success rate math", () => {
    it("computes rate as (fixed + superseded) / (fixed + superseded + blocked)", async () => {
      setupFiles(
        makeCompleted([]),
        makeFailed([
          "| 2026-01-01 | Task A | b1 | fixed | retry |",
          "| 2026-01-02 | Task B | b2 | fixed | retry |",
          "| 2026-01-03 | Task C | b3 | superseded | replaced |",
          "| 2026-01-04 | Task D | b4 | blocked | stuck |",
        ]),
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      // (2 fixed + 1 superseded) / (2 + 1 + 1 blocked) = 3/4 = 75%
      expect(output).toContain("Fix success rate:    75%");
      expect(output).toContain("3/4 resolved");
    });

    it("counts pending tasks separately", async () => {
      setupFiles(
        makeCompleted([]),
        makeFailed([
          "| 2026-01-01 | Task A | b1 | fixed | ok |",
          "| 2026-01-02 | Task B | b2 | pending | waiting |",
        ]),
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      expect(output).toContain("Total failed:        2");
      // pending doesn't count in fix rate denominator: 1 fixed / 1 resolved = 100%
      expect(output).toContain("Fix success rate:    100%");
      expect(output).toContain("1/1 resolved");
    });

    it("shows 0% when all resolved are blocked", async () => {
      setupFiles(
        makeCompleted([]),
        makeFailed([
          "| 2026-01-01 | Task A | b1 | blocked | stuck |",
          "| 2026-01-02 | Task B | b2 | blocked | stuck |",
        ]),
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      expect(output).toContain("Fix success rate:    0%");
      expect(output).toContain("0/2 resolved");
    });

    it("shows 0% when no resolved tasks exist", async () => {
      setupFiles(
        makeCompleted([]),
        makeFailed([
          "| 2026-01-01 | Task A | b1 | pending | waiting |",
        ]),
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      expect(output).toContain("Fix success rate:    0%");
      expect(output).toContain("0/0 resolved");
    });
  });

  // ──────────────────────────────────────────
  // Empty file handling
  // ──────────────────────────────────────────

  describe("empty file handling", () => {
    it("handles empty completed.md and failed-tasks.md", async () => {
      setupFiles("", "");

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      expect(output).toContain("Total completed:     0");
      expect(output).toContain("N/A (no duration data)");
      expect(output).toContain("Total failed:        0");
    });

    it("handles files with only headers (no data rows)", async () => {
      setupFiles(
        COMPLETED_HEADER + "\n",
        FAILED_HEADER + "\n",
      );

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      expect(output).toContain("Total completed:     0");
      expect(output).toContain("Total failed:        0");
    });

    it("handles missing files gracefully (readFileSync throws)", async () => {
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
        throw new Error("ENOENT: no such file");
      });

      await metricsCommand({ dir: "/tmp/test" });

      const output = getLogOutput();
      expect(output).toContain("Total completed:     0");
      expect(output).toContain("Total failed:        0");
    });
  });

  // ──────────────────────────────────────────
  // Config error
  // ──────────────────────────────────────────

  it("throws when config file is missing", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(metricsCommand({ dir: "/tmp/test" })).rejects.toThrow(
      "skynet.config.sh not found",
    );
  });
});
