// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { MonitoringDashboard } from "./MonitoringDashboard";
import { SkynetProvider } from "./SkynetProvider";
import type { MonitoringStatus } from "../types";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_STATUS: MonitoringStatus = {
  workers: [
    { name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "continuous", description: "Main dev worker", running: true, pid: 12345, ageMs: 60000, lastLog: null, lastLogTime: null, logFile: "dev-worker-1" },
    { name: "watchdog", label: "Watchdog", category: "core", schedule: "every 30s", description: "Monitors workers", running: false, pid: null, ageMs: null, lastLog: null, lastLogTime: null, logFile: "watchdog" },
    { name: "auth-refresh", label: "Auth Refresh", category: "infra", schedule: "every 5m", description: "Refreshes auth token", running: true, pid: 54321, ageMs: 120000, lastLog: null, lastLogTime: null, logFile: "auth-refresh" },
  ],
  currentTask: { status: "idle", title: null, branch: null, started: null, worker: null, lastInfo: null },
  currentTasks: {
    "worker-1": { status: "in_progress", title: "Implement feature X", branch: "feat/feature-x", started: "2024-01-01", worker: "1", lastInfo: null },
  },
  heartbeats: {},
  backlog: {
    items: [{ text: "[FEAT] Build dashboard", tag: "FEAT", status: "pending", blockedBy: [], blocked: false }],
    pendingCount: 3,
    claimedCount: 1,
    doneCount: 10,
  },
  completed: [{ date: "2024-01-01", task: "Setup project", branch: "feat/setup", duration: "1h", notes: "" }],
  completedCount: 15,
  averageTaskDuration: "45m",
  failed: [],
  failedPendingCount: 0,
  hasBlockers: false,
  blockerLines: [],
  healthScore: 85,
  selfCorrectionRate: 92,
  selfCorrectionStats: { fixed: 5, blocked: 1, superseded: 2, pending: 0, selfCorrected: 3 },
  syncHealth: { lastRun: "2024-01-01", endpoints: [] },
  auth: { tokenCached: true, tokenCacheAgeMs: 1000, authFailFlag: false, lastFailEpoch: null },
  backlogLocked: false,
  git: { branch: "main", commitsAhead: 0, dirtyFiles: 0, lastCommit: "abc123" },
  postCommitGate: { lastResult: "pass", lastCommit: "abc123", lastTime: "2024-01-01" },
  missionProgress: [],
  timestamp: "2024-01-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// EventSource mock
// ---------------------------------------------------------------------------

interface MockEventSource {
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
  url: string;
}

let mockES: MockEventSource;

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

describe("MonitoringDashboard", () => {
  beforeEach(() => {
    mockES = { onopen: null, onmessage: null, onerror: null, close: vi.fn(), url: "" };
    global.EventSource = vi.fn(function (this: MockEventSource, url: string) {
      Object.assign(this, mockES);
      mockES = this;
      mockES.url = url;
    } as unknown as typeof EventSource) as unknown as typeof EventSource;
    // Default fetch mock for sub-components (WorkerScaling, agents, logs)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], error: null }))
    ));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    renderWithProvider(<MonitoringDashboard />);
    expect(screen.getByText("Loading monitoring data...")).toBeDefined();
  });

  it("renders agent status cards (Workers Active count) after SSE data", async () => {
    renderWithProvider(<MonitoringDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Workers Active")).toBeDefined();
    });
    // 2 running out of 3 total
    const runningCount = MOCK_STATUS.workers.filter((w) => w.running).length;
    expect(screen.getByText(String(runningCount))).toBeDefined();
  });

  it("shows Running indicators for active workers in Pipeline Flow", async () => {
    renderWithProvider(<MonitoringDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Pipeline Flow")).toBeDefined();
    });
    // Running worker labels should be visible (may appear in multiple sections)
    expect(screen.getAllByText("Dev Worker 1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Watchdog").length).toBeGreaterThanOrEqual(1);
  });

  it("shows Stopped indicator for non-running workers", async () => {
    renderWithProvider(<MonitoringDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getAllByText("Watchdog").length).toBeGreaterThanOrEqual(1);
    });
    // The watchdog is not running — its dot should have bg-zinc-600 (stopped) class
    // Find a Pipeline Flow Node for watchdog and check for the stopped dot color
    const watchdogEls = screen.getAllByText("Watchdog");
    const watchdogEl = watchdogEls[0].closest("div");
    const dot = watchdogEl?.querySelector(".bg-zinc-600");
    expect(dot).not.toBeNull();
  });

  it("handles missing agent data gracefully", async () => {
    const statusWithNoWorkers: MonitoringStatus = {
      ...MOCK_STATUS,
      workers: [],
      currentTasks: {},
    };
    renderWithProvider(<MonitoringDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: statusWithNoWorkers, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Workers Active")).toBeDefined();
    });
    // 0 workers active
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
  });

  it("renders current task for active workers on overview tab", async () => {
    renderWithProvider(<MonitoringDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Implement feature X")).toBeDefined();
    });
    expect(screen.getByText("feat/feature-x")).toBeDefined();
  });

  it("shows error state when SSE returns error", async () => {
    renderWithProvider(<MonitoringDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: null, error: "Connection failed" }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Connection failed")).toBeDefined();
    });
  });

  it("renders Git Status section on overview tab", async () => {
    renderWithProvider(<MonitoringDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Git Status")).toBeDefined();
    });
    // "main" appears in both Git Status and Pipeline Flow sections
    expect(screen.getAllByText("main").length).toBeGreaterThanOrEqual(1);
  });

  it("renders Post-Commit Gate on overview tab", async () => {
    renderWithProvider(<MonitoringDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Post-Commit Gate")).toBeDefined();
    });
    expect(screen.getByText("pass")).toBeDefined();
  });

  it("renders tab navigation with all tabs", async () => {
    renderWithProvider(<MonitoringDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Overview")).toBeDefined();
    });
    expect(screen.getByText("Workers")).toBeDefined();
    expect(screen.getByText("Tasks")).toBeDefined();
    expect(screen.getByText("Logs")).toBeDefined();
    expect(screen.getByText("System")).toBeDefined();
  });

  it("closes EventSource on unmount", () => {
    const { unmount } = renderWithProvider(<MonitoringDashboard />);
    unmount();
    expect(mockES.close).toHaveBeenCalled();
  });
});
