// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MissionSidebar } from "./MissionSidebar";
import { SkynetProvider } from "./SkynetProvider";
import type { MissionSummary, PipelineStatus } from "../types";

const MOCK_MISSIONS: MissionSummary[] = [
  {
    slug: "mission-alpha",
    name: "Alpha Mission",
    isActive: true,
    assignedWorkers: ["dev-worker-1", "dev-worker-2"],
    completionPercentage: 65,
  },
  {
    slug: "mission-beta",
    name: "Beta Mission",
    isActive: false,
    assignedWorkers: [],
    completionPercentage: 100,
  },
];

const MOCK_PIPELINE: PipelineStatus = {
  workers: [],
  currentTask: { status: "idle", title: null, branch: null, started: null, worker: null, lastInfo: null },
  currentTasks: {
    "worker-1": { status: "in_progress", title: "Implement login", branch: "feat/login", started: "2024-11-14T22:00:00Z", worker: "worker-1", lastInfo: null },
    "worker-2": { status: "idle", title: null, branch: null, started: null, worker: "worker-2", lastInfo: null },
  },
  heartbeats: {},
  backlog: { items: [], pendingCount: 5, claimedCount: 2, manualDoneCount: 0 },
  completed: [],
  completedCount: 10,
  averageTaskDuration: "12m",
  failed: [],
  failedPendingCount: 1,
  hasBlockers: false,
  blockerLines: [],
  healthScore: 85,
  selfCorrectionRate: 0.2,
  selfCorrectionStats: { fixed: 2, blocked: 1, superseded: 0, pending: 0, selfCorrected: 2 },
  syncHealth: { lastRun: null, endpoints: [] },
  auth: {
    tokenCached: true,
    tokenCacheAgeMs: 1000,
    authFailFlag: false,
    lastFailEpoch: null,
    codex: { status: "ok", expiresInMs: null, hasRefreshToken: false, source: "api_key" },
    gemini: { status: "ok", source: "api_key" },
  },
  backlogLocked: false,
  git: { branch: "main", commitsAhead: 0, dirtyFiles: 0, lastCommit: null },
  postCommitGate: { lastResult: null, lastCommit: null, lastTime: null },
  missionState: null,
  missionProgress: [],
  missionAlignmentScore: 100,
  nonAlignedTaskCount: 0,
  goalCompletionPercentage: 0,
  laggingGoals: [],
  pipelinePaused: false,
  workerStats: {},
  watchdogRunning: true,
  projectDriverRunning: false,
  timestamp: "2024-11-14T22:13:20.000Z",
};

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockFetch(missions: MissionSummary[], pipeline: PipelineStatus) {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/missions")) {
      return Promise.resolve(new Response(JSON.stringify({ data: { missions } })));
    }
    if (url.includes("/pipeline/status")) {
      return Promise.resolve(new Response(JSON.stringify({ data: pipeline })));
    }
    return Promise.resolve(new Response(JSON.stringify({ data: null })));
  }));
}

describe("MissionSidebar", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading skeleton initially", () => {
    // Never resolving fetch to keep loading state
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderWithProvider(<MissionSidebar />);
    expect(document.querySelector(".animate-pulse")).toBeDefined();
  });

  it("renders mission names and slugs after data loads", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("Alpha Mission")).toBeDefined();
    });
    expect(screen.getByText("Beta Mission")).toBeDefined();
    expect(screen.getByText("mission-alpha")).toBeDefined();
    expect(screen.getByText("mission-beta")).toBeDefined();
  });

  it("renders completion percentages", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("65%")).toBeDefined();
    });
    expect(screen.getByText("100%")).toBeDefined();
  });

  it("highlights active mission with cyan styling", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("Alpha Mission")).toBeDefined();
    });
    const activeTitle = screen.getByText("Alpha Mission");
    expect(activeTitle.className).toContain("text-cyan-400");
    const inactiveTitle = screen.getByText("Beta Mission");
    expect(inactiveTitle.className).toContain("text-zinc-200");
  });

  it("shows assigned worker count for missions with workers", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("Assigned: 2")).toBeDefined();
    });
  });

  it("shows worker task titles from currentTasks", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("Implement login")).toBeDefined();
    });
    // Worker 2 is idle
    expect(screen.getByText("Idle")).toBeDefined();
  });

  it("displays worker short names (W1, W2)", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("W1")).toBeDefined();
    });
    expect(screen.getByText("W2")).toBeDefined();
  });

  it("shows WORKING status when watchdog is running and not paused", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("WORKING")).toBeDefined();
    });
  });

  it("shows STOPPED status when watchdog is not running", async () => {
    mockFetch(MOCK_MISSIONS, { ...MOCK_PIPELINE, watchdogRunning: false });
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("STOPPED")).toBeDefined();
    });
  });

  it("shows PAUSED status when pipeline is paused", async () => {
    mockFetch(MOCK_MISSIONS, { ...MOCK_PIPELINE, pipelinePaused: true });
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("PAUSED")).toBeDefined();
    });
  });

  it("shows ANALYZING status when project driver is running", async () => {
    mockFetch(MOCK_MISSIONS, { ...MOCK_PIPELINE, projectDriverRunning: true });
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("ANALYZING")).toBeDefined();
    });
  });

  it("renders auth badges for Claude, Codex, Gemini", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeDefined();
    });
    expect(screen.getByText("Codex")).toBeDefined();
    expect(screen.getByText("Gemini")).toBeDefined();
  });

  it("shows green auth badges when all auth is OK", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeDefined();
    });
    const badges = document.querySelectorAll(".bg-green-500");
    expect(badges.length).toBeGreaterThanOrEqual(3);
  });

  it("shows red auth badge when token is not cached", async () => {
    const noAuth = {
      ...MOCK_PIPELINE,
      auth: {
        ...MOCK_PIPELINE.auth,
        tokenCached: false,
        codex: { ...MOCK_PIPELINE.auth.codex, status: "missing" as const, source: "missing" as const },
        gemini: { ...MOCK_PIPELINE.auth.gemini, status: "missing" as const },
      },
    };
    mockFetch(MOCK_MISSIONS, noAuth);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeDefined();
    });
    const redBadges = document.querySelectorAll(".bg-red-500");
    expect(redBadges.length).toBeGreaterThanOrEqual(3);
  });

  it("displays health score and velocity in footer", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("Health")).toBeDefined();
    });
    expect(screen.getByText("85%")).toBeDefined();
    expect(screen.getByText("Velocity")).toBeDefined();
    expect(screen.getByText("12m")).toBeDefined();
  });

  it("shows green health score when above 80", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("85%")).toBeDefined();
    });
    const healthEl = screen.getByText("85%");
    expect(healthEl.className).toContain("text-green-500");
  });

  it("shows yellow health score when 80 or below", async () => {
    mockFetch(MOCK_MISSIONS, { ...MOCK_PIPELINE, healthScore: 75 });
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("75%")).toBeDefined();
    });
    const healthEl = screen.getByText("75%");
    expect(healthEl.className).toContain("text-yellow-500");
  });

  it("fetches from correct API endpoints", async () => {
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
    expect(global.fetch).toHaveBeenCalledWith("/api/admin/missions");
    expect(global.fetch).toHaveBeenCalledWith("/api/admin/pipeline/status");
  });

  it("sets auto-refresh interval at 10 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch(MOCK_MISSIONS, MOCK_PIPELINE);
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(global.fetch).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("handles fetch failure gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith("Failed to fetch sidebar data:", expect.any(Error));
    });
  });

  it("shows dashes when pipeline data is null", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/missions")) {
        return Promise.resolve(new Response(JSON.stringify({ data: { missions: MOCK_MISSIONS } })));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: null })));
    }));
    renderWithProvider(<MissionSidebar />);
    await waitFor(() => {
      expect(screen.getByText("Alpha Mission")).toBeDefined();
    });
    expect(screen.getByText("UNKNOWN")).toBeDefined();
    expect(screen.getByText("--%")).toBeDefined();
    expect(screen.getByText("--")).toBeDefined();
  });
});
