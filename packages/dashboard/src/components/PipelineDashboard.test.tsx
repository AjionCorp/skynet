// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import { PipelineDashboard } from "./PipelineDashboard";
import { SkynetProvider } from "./SkynetProvider";
import type { PipelineStatus } from "../types";

vi.mock("./ActivityFeed", () => ({
  ActivityFeed: () => <div>Activity Feed</div>,
}));

vi.mock("./HealthSparkline", () => ({
  HealthSparkline: () => <div data-testid="HealthSparkline" />,
}));

vi.mock("./TaskVelocityChart", () => ({
  TaskVelocityChart: () => <div data-testid="TaskVelocityChart" />,
}));

vi.mock("./WorkerPerformanceProfiles", () => ({
  WorkerPerformanceProfiles: () => <div data-testid="WorkerPerformanceProfiles" />,
}));

vi.mock("./MissionGoalProgress", () => ({
  MissionGoalProgress: () => <div data-testid="MissionGoalProgress" />,
}));

vi.mock("./VelocityEfficiencyPanel", () => ({
  VelocityEfficiencyPanel: () => <div data-testid="VelocityEfficiencyPanel" />,
}));

vi.mock("./FailureAnalysisPanel", () => ({
  FailureAnalysisPanel: () => <div data-testid="FailureAnalysisPanel" />,
}));

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
    manualDoneCount: 10,
  },
  completed: [{ date: "2024-01-01", task: "Setup project", branch: "feat/setup", duration: "1h", notes: "", filesTouched: "" }],
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
    gemini: { status: "ok", source: "api_key" },
  },
  backlogLocked: false,
  git: { branch: "main", commitsAhead: 0, dirtyFiles: 0, lastCommit: "abc123" },
  postCommitGate: { lastResult: "pass", lastCommit: "abc123", lastTime: "2024-01-01" },
  missionState: null,
  missionProgress: [],
  missionAlignmentScore: 100,
  nonAlignedTaskCount: 0,
  goalCompletionPercentage: 0,
  laggingGoals: [],
  pipelinePaused: false,
  workerStats: {},
  watchdogRunning: false,
  projectDriverRunning: false,
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

function mockFetchResponse(url: string) {
  if (url.includes("/pipeline/status")) {
    return new Response(JSON.stringify({ data: MOCK_STATUS, error: null }));
  }

  if (url.includes("/pipeline/logs")) {
    return new Response(JSON.stringify({ data: { lines: [] }, error: null }));
  }

  return new Response(JSON.stringify({ data: [], error: null }));
}

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
      mockES = Object.assign(this, { url });
      EventSourceSpy(url);
    } as unknown as typeof EventSource) as unknown as typeof EventSource;
    // Default fetch mock for bootstrap status fetches and log polling.
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return Promise.resolve(mockFetchResponse(url));
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    renderWithProvider(<PipelineDashboard />);
    expect(screen.getByText("Loading pipeline status...")).toBeDefined();
  });

  it("boots from the initial status fetch before SSE emits", async () => {
    renderWithProvider(<PipelineDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Good")).toBeDefined();
    });
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
    await waitFor(() => {
      expect(screen.getByText("Good")).toBeDefined();
    });
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
    await waitFor(() => {
      expect(screen.getByText("Good")).toBeDefined();
    });
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
    await waitFor(() => {
      expect(screen.getByText("Good")).toBeDefined();
    });
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
    await waitFor(() => {
      expect(screen.getByText("Good")).toBeDefined();
    });
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
      // "Reconnecting" text may appear in multiple spots (status bar, header, etc.)
      expect(screen.getAllByText(/Reconnecting/).length).toBeGreaterThanOrEqual(1);
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
    await waitFor(() => {
      expect(screen.getByText("Good")).toBeDefined();
    });
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

  it("falls back to REST status when SSE is silent", async () => {
    renderWithProvider(<PipelineDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Pipeline Dashboard")).toBeDefined();
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/admin/pipeline/status");
  });

  it("maps numbered worker runs to triggerable scripts", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/pipeline/status")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                ...MOCK_STATUS,
                workers: [
                  ...MOCK_STATUS.workers,
                  {
                    name: "task-fixer-2",
                    label: "Task Fixer 2",
                    category: "core",
                    schedule: "on demand",
                    description: "Fixes failed tasks",
                    running: false,
                    pid: null,
                    ageMs: null,
                    lastLog: null,
                    lastLogTime: null,
                    logFile: "task-fixer-2",
                  },
                ],
              },
              error: null,
            }),
          ),
        );
      }

      if (url.includes("/pipeline/trigger")) {
        return Promise.resolve(new Response(JSON.stringify({ data: { ok: true, body: init?.body }, error: null })));
      }

      return Promise.resolve(new Response(JSON.stringify({ data: [], error: null })));
    }));

    renderWithProvider(<PipelineDashboard />);

    await waitFor(() => {
      expect(screen.getAllByText("Run").length).toBeGreaterThanOrEqual(2);
    });

    fireEvent.click(screen.getAllByText("Run")[0]);

    await waitFor(() => {
      const triggerCall = vi.mocked(global.fetch).mock.calls.find(([input]) =>
        String(input).includes("/pipeline/trigger"),
      );
      expect(triggerCall).toBeDefined();
      expect(triggerCall?.[1]).toMatchObject({
        method: "POST",
        body: JSON.stringify({ script: "dev-worker", args: ["1"] }),
      });
    });
  });

  it("marks auto-managed workers instead of showing broken run buttons", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/pipeline/status")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                ...MOCK_STATUS,
                workers: [
                  ...MOCK_STATUS.workers,
                  {
                    name: "auth-refresh",
                    label: "Auth Refresh",
                    category: "infra",
                    schedule: "every 5m",
                    description: "Refreshes auth token",
                    running: false,
                    pid: null,
                    ageMs: null,
                    lastLog: null,
                    lastLogTime: null,
                    logFile: "auth-refresh",
                  },
                  {
                    name: "codex-auth-refresh",
                    label: "Codex Auth Refresh",
                    category: "infra",
                    schedule: "every 30m",
                    description: "Refreshes Codex auth token",
                    running: false,
                    pid: null,
                    ageMs: null,
                    lastLog: null,
                    lastLogTime: null,
                    logFile: "codex-auth-refresh",
                  },
                ],
              },
              error: null,
            }),
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [], error: null })));
    }));

    renderWithProvider(<PipelineDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Auth Refresh")).toBeDefined();
    });

    expect(screen.getAllByText("Auto-managed").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Run")).toHaveLength(1);
  });
});
