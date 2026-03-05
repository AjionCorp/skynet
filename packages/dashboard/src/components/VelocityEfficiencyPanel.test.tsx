// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { VelocityEfficiencyPanel } from "./VelocityEfficiencyPanel";
import { SkynetProvider } from "./SkynetProvider";
import type { WorkerPerformanceStats, VelocityDataPoint } from "../types";

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

const MOCK_WORKER_STATS: Record<string, WorkerPerformanceStats> = {
  "worker-1": makeWorkerStats({ completedCount: 15, failedCount: 1, avgDuration: "45m", successRate: 94 }),
  "worker-2": makeWorkerStats({ completedCount: 10, failedCount: 5, avgDuration: "1h 30m", successRate: 67 }),
  "worker-3": makeWorkerStats({ completedCount: 8, failedCount: 0, avgDuration: "2h", successRate: 100 }),
};

const EMPTY_WORKER_STATS: Record<string, WorkerPerformanceStats> = {};

function makeVelocityData(days: number): VelocityDataPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    date: `2026-03-${String(i + 1).padStart(2, "0")}`,
    count: Math.floor(Math.random() * 5) + 1,
    avgDurationMins: 45 + i * 5,
  }));
}

const MOCK_VELOCITY_RESPONSE = {
  data: makeVelocityData(14),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function stubFetch(response: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(response)))
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VelocityEfficiencyPanel", () => {
  beforeEach(() => {
    stubFetch(MOCK_VELOCITY_RESPONSE);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing when no worker stats and no velocity data", async () => {
    stubFetch({ data: [] });
    const { container } = renderWithProvider(
      <VelocityEfficiencyPanel workerStats={EMPTY_WORKER_STATS} />
    );
    // Wait for fetch to complete
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(container.innerHTML).toBe("");
  });

  it("renders the header with title", async () => {
    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(screen.getByText("Velocity & Worker Efficiency")).toBeDefined();
  });

  it("fetches velocity data from the correct endpoint", async () => {
    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/pipeline/task-velocity");
    });
  });

  it("starts collapsed and expands on click", async () => {
    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    // Initially collapsed — no table visible
    expect(screen.queryByText("Worker Efficiency")).toBeNull();

    // Click to expand
    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));
    expect(screen.getByText("Worker Efficiency")).toBeDefined();

    // Click to collapse
    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));
    expect(screen.queryByText("Worker Efficiency")).toBeNull();
  });

  it("displays worker efficiency table when expanded", async () => {
    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    // Check table headers
    expect(screen.getByText("Worker")).toBeDefined();
    expect(screen.getByText("Completed")).toBeDefined();
    expect(screen.getByText("Failed")).toBeDefined();
    expect(screen.getByText("Success")).toBeDefined();
    expect(screen.getByText("Avg Time")).toBeDefined();
    expect(screen.getByText("Tasks/hr")).toBeDefined();
  });

  it("displays worker IDs in sorted order", async () => {
    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    expect(screen.getByText("W1")).toBeDefined();
    expect(screen.getByText("W2")).toBeDefined();
    expect(screen.getByText("W3")).toBeDefined();
  });

  it("shows completed and failed counts per worker", async () => {
    const { container } = renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    // Check that the table has rows for each worker
    const rows = container.querySelectorAll("tbody tr");
    expect(rows.length).toBe(3);

    // Worker 1 row should contain completed=15 and failed=1
    const w1Cells = rows[0].querySelectorAll("td");
    expect(w1Cells[1].textContent).toBe("15"); // completed
    expect(w1Cells[2].textContent).toBe("1");  // failed
  });

  it("shows success rate per worker", async () => {
    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    expect(screen.getByText("94%")).toBeDefined();
    expect(screen.getByText("67%")).toBeDefined();
    expect(screen.getByText("100%")).toBeDefined();
  });

  it("shows tasks/hour for workers with duration data", async () => {
    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    // Worker 1: 45m → 60/45 = 1.3 tasks/hr
    expect(screen.getByText("1.3")).toBeDefined();
    // Worker 2: 1h 30m = 90m → 60/90 = 0.7 tasks/hr
    expect(screen.getByText("0.7")).toBeDefined();
    // Worker 3: 2h = 120m → 60/120 = 0.5 tasks/hr
    expect(screen.getByText("0.5")).toBeDefined();
  });

  it("displays velocity summary cards when expanded", async () => {
    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    await waitFor(() => {
      expect(screen.getByText("7-Day Velocity")).toBeDefined();
      expect(screen.getByText("Avg / Day")).toBeDefined();
      expect(screen.getByText("Week-over-Week")).toBeDefined();
    });
  });

  it("displays WoW change badge in header when data available", async () => {
    // Create controlled velocity data with clear trend
    const data: VelocityDataPoint[] = [
      // Prior 7 days: 2 tasks each = 14
      ...Array.from({ length: 7 }, (_, i) => ({
        date: `2026-02-${String(15 + i).padStart(2, "0")}`,
        count: 2,
        avgDurationMins: 30,
      })),
      // Recent 7 days: 4 tasks each = 28 (+100%)
      ...Array.from({ length: 7 }, (_, i) => ({
        date: `2026-02-${String(22 + i).padStart(2, "0")}`,
        count: 4,
        avgDurationMins: 25,
      })),
    ];
    stubFetch({ data });

    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );

    await waitFor(() => {
      expect(screen.getByText(/\+100% WoW/)).toBeDefined();
    });
  });

  it("shows declining trend for negative velocity change", async () => {
    const data: VelocityDataPoint[] = [
      // Prior 7 days: 5 tasks each = 35
      ...Array.from({ length: 7 }, (_, i) => ({
        date: `2026-02-${String(15 + i).padStart(2, "0")}`,
        count: 5,
        avgDurationMins: 30,
      })),
      // Recent 7 days: 2 tasks each = 14 (-60%)
      ...Array.from({ length: 7 }, (_, i) => ({
        date: `2026-02-${String(22 + i).padStart(2, "0")}`,
        count: 2,
        avgDurationMins: 25,
      })),
    ];
    stubFetch({ data });

    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );

    await waitFor(() => {
      expect(screen.getByText(/-60% WoW/)).toBeDefined();
    });
  });

  it("displays peak day when expanded", async () => {
    const data: VelocityDataPoint[] = [
      { date: "2026-03-01", count: 3, avgDurationMins: 30 },
      { date: "2026-03-02", count: 99, avgDurationMins: 25 },
      { date: "2026-03-03", count: 2, avgDurationMins: 40 },
    ];
    stubFetch({ data });

    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );

    // Expand panel
    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    // Wait for velocity data to load and render peak day
    await waitFor(() => {
      expect(screen.getByText("Peak Day")).toBeDefined();
    });

    expect(screen.getByText("99")).toBeDefined();
    expect(screen.getByText(/03-02/)).toBeDefined();
  });

  it("displays average duration summary when data available", async () => {
    const data: VelocityDataPoint[] = [
      { date: "2026-03-01", count: 3, avgDurationMins: 70 },
      { date: "2026-03-02", count: 5, avgDurationMins: 130 },
    ];
    stubFetch({ data });

    // Use minimal worker stats to avoid text collisions
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats(),
    };

    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={stats} />
    );

    // Expand panel
    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    // Wait for velocity data to load and render avg duration
    // Avg of 70 and 130 = 100 mins = 1h 40m
    await waitFor(() => {
      expect(screen.getByText("1h 40m")).toBeDefined();
    });
    expect(screen.getByText(/2 days/)).toBeDefined();
  });

  it("handles fetch error gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={MOCK_WORKER_STATS} />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    // Component should still render with worker stats
    expect(screen.getByText("Velocity & Worker Efficiency")).toBeDefined();
    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));
    expect(screen.getByText("Worker Efficiency")).toBeDefined();
  });

  it("shows -- for tasks/hr when worker has no duration", async () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ avgDuration: null }),
    };

    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={stats} />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));
    // Should show -- for both avg time and tasks/hr
    const dashes = screen.getAllByText("--");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it("applies emerald color for success rate >= 80", async () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ successRate: 90 }),
    };

    const { container } = renderWithProvider(
      <VelocityEfficiencyPanel workerStats={stats} />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    const rateCell = container.querySelector("td.text-emerald-400");
    expect(rateCell).not.toBeNull();
  });

  it("applies amber color for success rate 60-79", async () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ successRate: 65 }),
    };

    const { container } = renderWithProvider(
      <VelocityEfficiencyPanel workerStats={stats} />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    const rateCell = container.querySelector("td.text-amber-400");
    expect(rateCell).not.toBeNull();
  });

  it("applies red color for success rate < 60", async () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ successRate: 40 }),
    };

    const { container } = renderWithProvider(
      <VelocityEfficiencyPanel workerStats={stats} />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    const rateCell = container.querySelector("td.text-red-400");
    expect(rateCell).not.toBeNull();
  });

  it("skips workers with zero completed and zero failed", async () => {
    const stats: Record<string, WorkerPerformanceStats> = {
      "worker-1": makeWorkerStats({ completedCount: 5, failedCount: 1 }),
      "worker-2": makeWorkerStats({ completedCount: 0, failedCount: 0, successRate: 0 }),
    };

    renderWithProvider(
      <VelocityEfficiencyPanel workerStats={stats} />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("Velocity & Worker Efficiency"));

    expect(screen.getByText("W1")).toBeDefined();
    expect(screen.queryByText("W2")).toBeNull();
  });
});
