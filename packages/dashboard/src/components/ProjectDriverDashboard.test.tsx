// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { ProjectDriverDashboard } from "./ProjectDriverDashboard";
import { SkynetProvider } from "./SkynetProvider";
import type { ProjectDriverStatus } from "../types";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_STATUS_RUNNING: ProjectDriverStatus = {
  running: true,
  pid: 12345,
  ageMs: 300000,
  lastLog: "[2024-01-01] Processing backlog items...",
  lastLogTime: "2024-01-01T12:00:00Z",
  telemetry: {
    pendingBacklog: 8,
    claimedBacklog: 3,
    pendingRetries: 2,
    fixRate: 75,
    duplicateSkipped: 4,
    maxNewTasks: 10,
    driver_low_fix_rate_mode: false,
    ts: "2024-01-01T12:00:00Z",
  },
};

const MOCK_STATUS_IDLE: ProjectDriverStatus = {
  running: false,
  pid: null,
  ageMs: null,
  lastLog: null,
  lastLogTime: null,
  telemetry: null,
};

const MOCK_STATUS_LOW_FIX_RATE: ProjectDriverStatus = {
  ...MOCK_STATUS_RUNNING,
  telemetry: {
    ...MOCK_STATUS_RUNNING.telemetry!,
    fixRate: 30,
    pendingRetries: 15,
    driver_low_fix_rate_mode: true,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockFetchStatus(status: ProjectDriverStatus) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: status, error: null }))
  ));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProjectDriverDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    renderWithProvider(<ProjectDriverDashboard />);
    expect(screen.getByText("Loading project driver status...")).toBeDefined();
  });

  it("renders header with Running badge when driver is active", async () => {
    mockFetchStatus(MOCK_STATUS_RUNNING);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Project Driver")).toBeDefined();
      expect(screen.getByText("Running")).toBeDefined();
    });
  });

  it("renders header with Idle badge when driver is stopped", async () => {
    mockFetchStatus(MOCK_STATUS_IDLE);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Project Driver")).toBeDefined();
      expect(screen.getByText("Idle")).toBeDefined();
    });
  });

  it("renders telemetry metric cards when data is available", async () => {
    mockFetchStatus(MOCK_STATUS_RUNNING);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Pending Backlog")).toBeDefined();
      expect(screen.getByText("8")).toBeDefined();
      expect(screen.getByText("Claimed")).toBeDefined();
      expect(screen.getByText("3")).toBeDefined();
      expect(screen.getByText("Pending Retries")).toBeDefined();
      expect(screen.getByText("2")).toBeDefined();
      expect(screen.getByText("Fix Rate")).toBeDefined();
      expect(screen.getByText("75%")).toBeDefined();
    });
  });

  it("shows 'No telemetry available' when telemetry is null", async () => {
    mockFetchStatus(MOCK_STATUS_IDLE);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("No telemetry available")).toBeDefined();
    });
  });

  it("renders additional metrics row (duplicates, max tasks, last run)", async () => {
    mockFetchStatus(MOCK_STATUS_RUNNING);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Duplicates Skipped")).toBeDefined();
      expect(screen.getByText("4")).toBeDefined();
      expect(screen.getByText("Max New Tasks")).toBeDefined();
      expect(screen.getByText("10")).toBeDefined();
      expect(screen.getByText("Last Run")).toBeDefined();
    });
  });

  it("renders last log entry when available", async () => {
    mockFetchStatus(MOCK_STATUS_RUNNING);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Last Log Entry")).toBeDefined();
      expect(screen.getByText("[2024-01-01] Processing backlog items...")).toBeDefined();
    });
  });

  it("does not render last log section when lastLog is null", async () => {
    mockFetchStatus(MOCK_STATUS_IDLE);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Project Driver")).toBeDefined();
    });

    expect(screen.queryByText("Last Log Entry")).toBeNull();
  });

  it("renders process info with PID and runtime when running", async () => {
    mockFetchStatus(MOCK_STATUS_RUNNING);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Process Info")).toBeDefined();
      // PID 12345, ageMs 300000 → 5m
      expect(screen.getByText(/PID 12345/)).toBeDefined();
      expect(screen.getByText(/running for 5m/)).toBeDefined();
    });
  });

  it("does not render process info when idle", async () => {
    mockFetchStatus(MOCK_STATUS_IDLE);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Project Driver")).toBeDefined();
    });

    expect(screen.queryByText("Process Info")).toBeNull();
  });

  it("shows low fix rate mode warning when active", async () => {
    mockFetchStatus(MOCK_STATUS_LOW_FIX_RATE);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Low Fix Rate Mode Active")).toBeDefined();
      expect(screen.getByText(/biased toward reliability/)).toBeDefined();
    });
  });

  it("does not show low fix rate warning in normal mode", async () => {
    mockFetchStatus(MOCK_STATUS_RUNNING);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Project Driver")).toBeDefined();
    });

    expect(screen.queryByText("Low Fix Rate Mode Active")).toBeNull();
  });

  it("disables trigger button when driver is running", async () => {
    mockFetchStatus(MOCK_STATUS_RUNNING);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      const triggerBtn = screen.getByText("Trigger Run").closest("button");
      expect(triggerBtn?.disabled).toBe(true);
    });
  });

  it("enables trigger button when driver is idle", async () => {
    mockFetchStatus(MOCK_STATUS_IDLE);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      const triggerBtn = screen.getByText("Trigger Run").closest("button");
      expect(triggerBtn?.disabled).toBe(false);
    });
  });

  it("sends POST to trigger endpoint when trigger button is clicked", async () => {
    const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { ok: true }, error: null }))
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: MOCK_STATUS_IDLE, error: null }))
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Trigger Run")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Trigger Run"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/pipeline/trigger",
        expect.objectContaining({ method: "POST" })
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Project driver triggered")).toBeDefined();
    });
  });

  it("shows error message when trigger fails", async () => {
    const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ data: null, error: "Already running" }))
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: MOCK_STATUS_IDLE, error: null }))
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Trigger Run")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Trigger Run"));

    await waitFor(() => {
      expect(screen.getByText("Error: Already running")).toBeDefined();
    });
  });

  it("shows error banner when fetch returns error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: null, error: "Connection refused" }))
    ));

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Connection refused")).toBeDefined();
    });
  });

  it("shows error banner when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeDefined();
    });
  });

  it("fetches from the correct API endpoint", async () => {
    mockFetchStatus(MOCK_STATUS_RUNNING);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/project-driver/status");
    });
  });

  it("renders Refresh button that re-fetches status", async () => {
    mockFetchStatus(MOCK_STATUS_RUNNING);

    renderWithProvider(<ProjectDriverDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Refresh")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => {
      // Initial fetch + refresh fetch
      expect(vi.mocked(global.fetch).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
