// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { FailureAnalysisPanel } from "./FailureAnalysisPanel";
import { SkynetProvider } from "./SkynetProvider";
import type { FailureAnalysis } from "../types";

const MOCK_DATA: FailureAnalysis = {
  summary: {
    total: 10,
    fixed: 5,
    blocked: 2,
    superseded: 1,
    pending: 2,
    selfCorrected: 6,
  },
  errorPatterns: [
    { pattern: "Type error", count: 4, tasks: ["task-1", "task-2", "task-3", "task-4"] },
    { pattern: "Build failure", count: 2, tasks: ["task-5"] },
  ],
  timeline: [
    { date: "2024-01-01", failures: 3, fixed: 2, blocked: 1, superseded: 0 },
    { date: "2024-01-02", failures: 5, fixed: 5, blocked: 0, superseded: 0 },
    { date: "2024-01-03", failures: 0, fixed: 0, blocked: 0, superseded: 0 },
  ],
  byWorker: [
    { workerId: 1, failures: 6, fixed: 4, avgAttempts: 2.3 },
    { workerId: 2, failures: 4, fixed: 1, avgAttempts: 1.5 },
  ],
  recentFailures: [
    { date: "2024-01-03", task: "Add auth", branch: "feat/auth", error: "Type mismatch", attempts: "2", status: "fixed", outcomeReason: "", filesTouched: "" },
    { date: "2024-01-03", task: "Fix login", branch: "fix/login", error: "Build failed", attempts: "3", status: "blocked", outcomeReason: "", filesTouched: "" },
    { date: "2024-01-02", task: "Add tests", branch: "test/add", error: "Timeout", attempts: "1", status: "pending-retry", outcomeReason: "", filesTouched: "" },
  ],
};

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockFetchWith(data: FailureAnalysis | null) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data }))
  ));
}

describe("FailureAnalysisPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing when data has zero total failures", async () => {
    const emptyData: FailureAnalysis = {
      ...MOCK_DATA,
      summary: { ...MOCK_DATA.summary, total: 0 },
    };
    mockFetchWith(emptyData);
    const { container } = renderWithProvider(<FailureAnalysisPanel />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    // Should render nothing
    expect(container.innerHTML).toBe("");
  });

  it("renders collapsed header with summary badges", async () => {
    mockFetchWith(MOCK_DATA);
    renderWithProvider(<FailureAnalysisPanel />);
    await waitFor(() => {
      expect(screen.getByText("Failure Analysis")).toBeDefined();
    });
    expect(screen.getByText("10 total")).toBeDefined();
    expect(screen.getByText("2 pending")).toBeDefined();
  });

  it("does not show pending badge when pending is 0", async () => {
    const noPending: FailureAnalysis = {
      ...MOCK_DATA,
      summary: { ...MOCK_DATA.summary, pending: 0 },
    };
    mockFetchWith(noPending);
    renderWithProvider(<FailureAnalysisPanel />);
    await waitFor(() => {
      expect(screen.getByText("Failure Analysis")).toBeDefined();
    });
    expect(screen.queryByText("0 pending")).toBeNull();
  });

  it("expands to show details on click", async () => {
    mockFetchWith(MOCK_DATA);
    renderWithProvider(<FailureAnalysisPanel />);
    await waitFor(() => {
      expect(screen.getByText("Failure Analysis")).toBeDefined();
    });
    // Details should not be visible initially
    expect(screen.queryByText("Total Failures")).toBeNull();

    fireEvent.click(screen.getByText("Failure Analysis"));

    // Summary cards (use getAllByText where labels may duplicate with status text)
    expect(screen.getByText("Total Failures")).toBeDefined();
    expect(screen.getAllByText("Fixed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Blocked").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Superseded")).toBeDefined();
    expect(screen.getByText("Self-Correction")).toBeDefined();
    // Fix rate: 6/10 = 60%
    expect(screen.getByText("60%")).toBeDefined();
  });

  it("renders error patterns table when expanded", async () => {
    mockFetchWith(MOCK_DATA);
    renderWithProvider(<FailureAnalysisPanel />);
    await waitFor(() => {
      expect(screen.getByText("Failure Analysis")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Failure Analysis"));

    expect(screen.getByText("Error Patterns")).toBeDefined();
    expect(screen.getByText("Type error")).toBeDefined();
    expect(screen.getByText("Build failure")).toBeDefined();
    // Truncated tasks: 3 shown + "+1 more"
    expect(screen.getByText(/\+1 more/)).toBeDefined();
  });

  it("renders failure timeline when expanded", async () => {
    mockFetchWith(MOCK_DATA);
    renderWithProvider(<FailureAnalysisPanel />);
    await waitFor(() => {
      expect(screen.getByText("Failure Analysis")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Failure Analysis"));

    expect(screen.getByText(/Failure Timeline/)).toBeDefined();
    // Date labels (slice(5) of dates)
    expect(screen.getByText("01-01")).toBeDefined();
    expect(screen.getByText("01-02")).toBeDefined();
    expect(screen.getByText("01-03")).toBeDefined();
  });

  it("renders per-worker stats when expanded", async () => {
    mockFetchWith(MOCK_DATA);
    renderWithProvider(<FailureAnalysisPanel />);
    await waitFor(() => {
      expect(screen.getByText("Failure Analysis")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Failure Analysis"));

    expect(screen.getByText("Failures by Worker")).toBeDefined();
    expect(screen.getByText("2.3")).toBeDefined();
    expect(screen.getByText("1.5")).toBeDefined();
  });

  it("renders recent failures with status icons", async () => {
    mockFetchWith(MOCK_DATA);
    renderWithProvider(<FailureAnalysisPanel />);
    await waitFor(() => {
      expect(screen.getByText("Failure Analysis")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Failure Analysis"));

    expect(screen.getByText("Recent Failures")).toBeDefined();
    expect(screen.getByText("Add auth")).toBeDefined();
    expect(screen.getByText("Fix login")).toBeDefined();
    expect(screen.getByText("Add tests")).toBeDefined();
    // Status labels
    expect(screen.getByText("fixed")).toBeDefined();
    expect(screen.getByText("blocked")).toBeDefined();
    expect(screen.getByText("pending-retry")).toBeDefined();
  });

  it("sets auto-refresh interval at 60s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchWith(MOCK_DATA);
    renderWithProvider(<FailureAnalysisPanel />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("renders nothing when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const { container } = renderWithProvider(<FailureAnalysisPanel />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(container.innerHTML).toBe("");
  });
});
