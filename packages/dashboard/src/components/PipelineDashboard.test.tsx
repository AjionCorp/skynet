// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { PipelineDashboard } from "./PipelineDashboard";
import { SkynetProvider } from "./SkynetProvider";
import type { PipelineStatus } from "../types";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_STATUS: PipelineStatus = {
  workers: [
    { name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "continuous", description: "Main dev worker", running: true, pid: 12345, ageMs: 60000, lastLog: null, lastLogTime: null, logFile: "dev-worker-1" },
    { name: "watchdog", label: "Watchdog", category: "core", schedule: "every 30s", description: "Monitors workers", running: false, pid: null, ageMs: null, lastLog: null, lastLogTime: null, logFile: "watchdog" },
  ],
  currentTask: { status: "idle", title: null, branch: null, started: null, worker: null, lastInfo: null },
  currentTasks: {
    "worker-1": { status: "in_progress", title: "Add login feature", branch: "feat/login", started: "2024-01-01", worker: "1", lastInfo: null },
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
  auth: {
    tokenCached: true,
    tokenCacheAgeMs: 1000,
    authFailFlag: false,
    lastFailEpoch: null,
    codex: { status: "ok", expiresInMs: 3600000, hasRefreshToken: true, source: "file" },
  },
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
const EventSourceSpy = vi.fn();

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

describe("PipelineDashboard", () => {
  beforeEach(() => {
    mockES = { onopen: null, onmessage: null, onerror: null, close: vi.fn(), url: "" };
    EventSourceSpy.mockClear();
    // Use a regular function (not arrow) so it works as a constructor with `new`
    global.EventSource = vi.fn(function (this: MockEventSource, url: string) {
      Object.assign(this, mockES);
      mockES = this;
      mockES.url = url;
      EventSourceSpy(url);
    } as unknown as typeof EventSource) as unknown as typeof EventSource;
    // Default fetch mock for ActivityFeed sub-component and any other fetches
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], error: null }))
    ));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    renderWithProvider(<PipelineDashboard />);
    expect(screen.getByText("Loading pipeline status...")).toBeDefined();
  });

  it("renders health score badge with correct color for good health", async () => {
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("85")).toBeDefined();
    });
    expect(screen.getByText("Good")).toBeDefined();
    // Health = 85 -> "emerald" color
    const badge = screen.getByText("Good");
    expect(badge.className).toContain("emerald");
  });

  it("renders health score badge as Degraded for mid-range health", async () => {
    const degraded = { ...MOCK_STATUS, healthScore: 60 };
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: degraded, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("60")).toBeDefined();
    });
    expect(screen.getByText("Degraded")).toBeDefined();
    const badge = screen.getByText("Degraded");
    expect(badge.className).toContain("amber");
  });

  it("renders health score badge as Critical for low health", async () => {
    const critical = { ...MOCK_STATUS, healthScore: 30 };
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: critical, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("30")).toBeDefined();
    });
    expect(screen.getByText("Critical")).toBeDefined();
    const badge = screen.getByText("Critical");
    expect(badge.className).toContain("red");
  });

  it("shows claimed badge for failed tasks being fixed", async () => {
    const withFailed = {
      ...MOCK_STATUS,
      failedPendingCount: 2,
      failed: [
        { date: "2024-01-01", task: "Fix login", branch: "fix/login", error: "Typecheck", attempts: "1", status: "pending" },
        { date: "2024-01-02", task: "Fix billing", branch: "fix/billing", error: "Tests", attempts: "2", status: "fixing-2" },
      ],
    };
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: withFailed, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Failed Tasks")).toBeDefined();
    });
    expect(screen.getByText("Claimed by F2")).toBeDefined();
  });

  it("renders task fixer section with active fixer tasks", async () => {
    const withFixers = {
      ...MOCK_STATUS,
      failedPendingCount: 1,
      failed: [
        { date: "2024-01-02", task: "Fix billing", branch: "fix/billing", error: "Tests", attempts: "2", status: "fixing-2" },
      ],
    };
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: withFixers, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Task Fixers")).toBeDefined();
    });
    expect(screen.getByText("Fixer F2")).toBeDefined();
  });

  it("renders self-correction rate display", async () => {
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("92%")).toBeDefined();
    });
    expect(screen.getByText("Self-Correction")).toBeDefined();
    // "5 fixed + 2 routed around"
    expect(screen.getByText("5 fixed + 2 routed around")).toBeDefined();
  });

  it("renders ActivityFeed section", async () => {
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Activity Feed")).toBeDefined();
    });
  });

  it("attempts SSE connection to correct endpoint", () => {
    renderWithProvider(<PipelineDashboard />);
    expect(EventSourceSpy).toHaveBeenCalledWith("/api/admin/pipeline/stream");
  });

  it("shows connected status when SSE opens", async () => {
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await act(async () => {
      mockES.onopen?.();
    });
    await waitFor(() => {
      expect(screen.getByText(/Live updates via SSE/)).toBeDefined();
    });
  });

  it("shows reconnecting when SSE errors", async () => {
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await act(async () => {
      mockES.onerror?.();
    });
    await waitFor(() => {
      expect(screen.getByText(/Reconnecting/)).toBeDefined();
    });
  });

  it("renders worker count and backlog/completed/failed summary", async () => {
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Workers Active")).toBeDefined();
    });
    // Backlog and Completed labels (appear in both summary cards and section headings)
    expect(screen.getAllByText("Backlog").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Completed").length).toBeGreaterThanOrEqual(1);
    // Completed count (15 appears in summary card and section badge)
    expect(screen.getAllByText("15").length).toBeGreaterThanOrEqual(1);
    // Backlog pendingCount (3 appears in summary card and section badge)
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1);
  });

  it("renders current task for active workers", async () => {
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: MOCK_STATUS, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Add login feature")).toBeDefined();
    });
    expect(screen.getByText("feat/login")).toBeDefined();
  });

  it("renders blockers alert when hasBlockers is true", async () => {
    const withBlockers = { ...MOCK_STATUS, hasBlockers: true, blockerLines: ["API key expired", "DB connection lost"] };
    renderWithProvider(<PipelineDashboard />);
    await act(async () => {
      mockES.onmessage?.({ data: JSON.stringify({ data: withBlockers, error: null }) });
    });
    await waitFor(() => {
      expect(screen.getByText("Active Blockers")).toBeDefined();
    });
    expect(screen.getByText("API key expired")).toBeDefined();
    expect(screen.getByText("DB connection lost")).toBeDefined();
  });

  it("closes EventSource on unmount", () => {
    const { unmount } = renderWithProvider(<PipelineDashboard />);
    unmount();
    expect(mockES.close).toHaveBeenCalled();
  });
});
