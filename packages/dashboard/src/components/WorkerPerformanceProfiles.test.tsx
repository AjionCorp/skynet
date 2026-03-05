// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { WorkerPerformanceProfiles } from "./WorkerPerformanceProfiles";
import { SkynetProvider } from "./SkynetProvider";
import type { WorkerPerformanceStats, TaskTypeAffinity } from "../types";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

function makeWorkerStats(overrides: Partial<WorkerPerformanceStats> = {}): WorkerPerformanceStats {
  return {
    completedCount: 10,
    failedCount: 2,
    avgDuration: "1h 30m",
    successRate: 83,
    tagBreakdown: {},
    taskTypeAffinity: [],
    ...overrides,
  };
}

function makeAffinity(overrides: Partial<TaskTypeAffinity> = {}): TaskTypeAffinity {
  return { tag: "FIX", completed: 5, failed: 1, successRate: 83, ...overrides };
}

const MOCK_STATS: Record<string, WorkerPerformanceStats> = {
  "worker-1": makeWorkerStats({ completedCount: 15, failedCount: 1, avgDuration: "45m", successRate: 94 }),
  "worker-2": makeWorkerStats({ completedCount: 10, failedCount: 5, avgDuration: "1h 30m", successRate: 67 }),
  "worker-3": makeWorkerStats({ completedCount: 8, failedCount: 0, avgDuration: "2h", successRate: 100 }),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkerPerformanceProfiles", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when workerStats is empty", () => {
    const { container } = renderWithProvider(
      <WorkerPerformanceProfiles workerStats={{}} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders the header with title and active count", () => {
    renderWithProvider(<WorkerPerformanceProfiles workerStats={MOCK_STATS} />);
    expect(screen.getByText("Worker Performance Profiles")).toBeDefined();
    expect(screen.getByText("3 active")).toBeDefined();
  });

  it("starts collapsed and expands on click", () => {
    renderWithProvider(<WorkerPerformanceProfiles workerStats={MOCK_STATS} />);

    // Initially collapsed — no worker cards visible
    expect(screen.queryByText("Overall Success")).toBeNull();

    // Expand
    fireEvent.click(screen.getByText("Worker Performance Profiles"));
    expect(screen.getByText("Overall Success")).toBeDefined();

    // Collapse
    fireEvent.click(screen.getByText("Worker Performance Profiles"));
    expect(screen.queryByText("Overall Success")).toBeNull();
  });

  it("shows overall success rate when expanded", () => {
    renderWithProvider(<WorkerPerformanceProfiles workerStats={MOCK_STATS} />);
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    // 15+10+8=33 completed, 1+5+0=6 failed, 33/39 = 85%
    expect(screen.getByText("85%")).toBeDefined();
  });

  it("shows top performer card", () => {
    renderWithProvider(<WorkerPerformanceProfiles workerStats={MOCK_STATS} />);
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    expect(screen.getByText("Top Performer")).toBeDefined();
    // Worker 3 has 100% success rate
    expect(screen.getByText(/W3/)).toBeDefined();
  });

  it("shows needs attention card for worst performer", () => {
    renderWithProvider(<WorkerPerformanceProfiles workerStats={MOCK_STATS} />);
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    expect(screen.getByText("Needs Attention")).toBeDefined();
    // Worker 2 has 67% success rate (lowest)
    expect(screen.getByText(/W2/)).toBeDefined();
  });

  it("hides needs attention when only one active worker", () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ successRate: 90, completedCount: 9, failedCount: 1 }),
    };
    renderWithProvider(<WorkerPerformanceProfiles workerStats={stats} />);
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    expect(screen.getByText("Top Performer")).toBeDefined();
    expect(screen.queryByText("Needs Attention")).toBeNull();
  });

  it("displays worker cards in sorted order", () => {
    renderWithProvider(<WorkerPerformanceProfiles workerStats={MOCK_STATS} />);
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    expect(screen.getByText("Worker 1")).toBeDefined();
    expect(screen.getByText("Worker 2")).toBeDefined();
    expect(screen.getByText("Worker 3")).toBeDefined();
  });

  it("shows completed and failed counts per worker", () => {
    renderWithProvider(<WorkerPerformanceProfiles workerStats={MOCK_STATS} />);
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    // Worker 1: 15 completed, 1 failed
    expect(screen.getByText("15")).toBeDefined();
    // Worker 3: 8 completed, 0 failed
    expect(screen.getByText("8")).toBeDefined();
  });

  it("shows average duration per worker", () => {
    renderWithProvider(<WorkerPerformanceProfiles workerStats={MOCK_STATS} />);
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    expect(screen.getByText("45m")).toBeDefined();
    expect(screen.getByText("2h")).toBeDefined();
  });

  it("shows -- when avgDuration is null", () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ avgDuration: null, completedCount: 3, failedCount: 1 }),
    };
    renderWithProvider(<WorkerPerformanceProfiles workerStats={stats} />);
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    const dashes = screen.getAllByText("--");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it("shows 'No tasks yet' for worker with zero tasks", () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ completedCount: 5, failedCount: 1, successRate: 83 }),
      "worker-2": makeWorkerStats({ completedCount: 0, failedCount: 0, successRate: 0 }),
    };
    renderWithProvider(<WorkerPerformanceProfiles workerStats={stats} />);
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    expect(screen.getByText("No tasks yet")).toBeDefined();
  });

  it("renders task type affinity section", () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({
        completedCount: 10,
        failedCount: 2,
        successRate: 83,
        taskTypeAffinity: [
          makeAffinity({ tag: "FIX", completed: 5, failed: 1, successRate: 83 }),
          makeAffinity({ tag: "FEAT", completed: 3, failed: 0, successRate: 100 }),
        ],
      }),
    };
    renderWithProvider(<WorkerPerformanceProfiles workerStats={stats} />);
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    expect(screen.getByText("Task Type Affinity")).toBeDefined();
    expect(screen.getByText("FIX")).toBeDefined();
    expect(screen.getByText("FEAT")).toBeDefined();
    expect(screen.getByText("83% (6)")).toBeDefined();
    expect(screen.getByText("100% (3)")).toBeDefined();
  });

  it("limits task type affinity to 5 entries", () => {
    const affinities = Array.from({ length: 7 }, (_, i) =>
      makeAffinity({ tag: `TAG${i}`, completed: 3, failed: 1, successRate: 75 })
    );
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ taskTypeAffinity: affinities }),
    };
    renderWithProvider(<WorkerPerformanceProfiles workerStats={stats} />);
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    // First 5 should be visible
    for (let i = 0; i < 5; i++) {
      expect(screen.getByText(`TAG${i}`)).toBeDefined();
    }
    // TAG5 and TAG6 should not be rendered
    expect(screen.queryByText("TAG5")).toBeNull();
    expect(screen.queryByText("TAG6")).toBeNull();
  });

  it("excludes zero-task workers from active count", () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ completedCount: 5, failedCount: 1 }),
      "worker-2": makeWorkerStats({ completedCount: 0, failedCount: 0, successRate: 0 }),
    };
    renderWithProvider(<WorkerPerformanceProfiles workerStats={stats} />);
    expect(screen.getByText("1 active")).toBeDefined();
  });

  it("applies emerald color for high success rate", () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ successRate: 90, completedCount: 9, failedCount: 1 }),
    };
    const { container } = renderWithProvider(
      <WorkerPerformanceProfiles workerStats={stats} />
    );
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    expect(container.querySelector(".text-emerald-400")).not.toBeNull();
  });

  it("applies amber color for medium success rate", () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ successRate: 65, completedCount: 13, failedCount: 7 }),
    };
    const { container } = renderWithProvider(
      <WorkerPerformanceProfiles workerStats={stats} />
    );
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    expect(container.querySelector(".text-amber-400")).not.toBeNull();
  });

  it("applies red color for low success rate", () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ successRate: 40, completedCount: 4, failedCount: 6 }),
    };
    const { container } = renderWithProvider(
      <WorkerPerformanceProfiles workerStats={stats} />
    );
    fireEvent.click(screen.getByText("Worker Performance Profiles"));

    expect(container.querySelector(".text-red-400")).not.toBeNull();
  });
});
