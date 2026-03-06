// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { WorkerIntents } from "./WorkerIntents";
import { SkynetProvider } from "./SkynetProvider";
import type { WorkerIntent } from "../types";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

function makeIntent(overrides: Partial<WorkerIntent> = {}): WorkerIntent {
  return {
    workerId: 1,
    workerType: "dev",
    status: "in_progress",
    taskId: 42,
    taskTitle: "Add feature X",
    branch: "dev/add-feature-x",
    startedAt: "2026-03-05 10:00",
    lastHeartbeat: Date.now(),
    heartbeatAgeMs: 5000,
    lastProgress: Date.now(),
    progressAgeMs: 3000,
    lastInfo: "Running typecheck...",
    updatedAt: "2026-03-05T10:00:00Z",
    ...overrides,
  };
}

const MOCK_INTENTS: WorkerIntent[] = [
  makeIntent({ workerId: 1, status: "in_progress", taskTitle: "Add feature X", branch: "dev/add-feature-x" }),
  makeIntent({ workerId: 2, status: "claimed", taskTitle: "Fix bug Y", branch: "dev/fix-bug-y", heartbeatAgeMs: 120000, startedAt: "2026-03-05 11:30", lastInfo: "Claiming task..." }),
  makeIntent({ workerId: 3, status: "idle", taskTitle: null, branch: null, lastInfo: null, heartbeatAgeMs: null, startedAt: null }),
];

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

describe("WorkerIntents", () => {
  beforeEach(() => {
    stubFetch({ data: { intents: MOCK_INTENTS } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading spinner initially", () => {
    // Use a fetch that never resolves to keep loading state
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const { container } = renderWithProvider(<WorkerIntents pollInterval={60000} />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("fetches intents from the correct endpoint", async () => {
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/workers/intents");
    });
  });

  it("renders the header with title and count", async () => {
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("Worker Intents")).toBeDefined();
    });
    expect(screen.getByText("3 active")).toBeDefined();
  });

  it("renders empty state when no intents", async () => {
    stubFetch({ data: { intents: [] } });
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("No active intents")).toBeDefined();
    });
  });

  it("renders worker IDs for each intent", async () => {
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("Worker 1")).toBeDefined();
    });
    expect(screen.getByText("Worker 2")).toBeDefined();
    expect(screen.getByText("Worker 3")).toBeDefined();
  });

  it("renders status badges with correct text", async () => {
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("in_progress")).toBeDefined();
    });
    expect(screen.getByText("claimed")).toBeDefined();
    expect(screen.getByText("idle")).toBeDefined();
  });

  it("renders task titles when present", async () => {
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("Add feature X")).toBeDefined();
    });
    expect(screen.getByText("Fix bug Y")).toBeDefined();
  });

  it("renders branch names when present", async () => {
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("dev/add-feature-x")).toBeDefined();
    });
    expect(screen.getByText("dev/fix-bug-y")).toBeDefined();
  });

  it("renders startedAt when present", async () => {
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("2026-03-05 10:00")).toBeDefined();
    });
  });

  it("renders lastInfo when present", async () => {
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("Running typecheck...")).toBeDefined();
    });
  });

  it("formats heartbeat age in seconds", async () => {
    stubFetch({ data: { intents: [makeIntent({ heartbeatAgeMs: 30000 })] } });
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("30s ago")).toBeDefined();
    });
  });

  it("formats heartbeat age in minutes", async () => {
    stubFetch({ data: { intents: [makeIntent({ heartbeatAgeMs: 120000 })] } });
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("2m ago")).toBeDefined();
    });
  });

  it("formats heartbeat age in hours", async () => {
    stubFetch({ data: { intents: [makeIntent({ heartbeatAgeMs: 3900000 })] } });
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("1h 5m ago")).toBeDefined();
    });
  });

  it("shows dash for null heartbeat age", async () => {
    stubFetch({ data: { intents: [makeIntent({ heartbeatAgeMs: null })] } });
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("—")).toBeDefined();
    });
  });

  it("displays error message on API error response", async () => {
    stubFetch({ error: "Intent file not found" });
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("Intent file not found")).toBeDefined();
    });
  });

  it("displays HTTP status when server returns non-JSON error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Service unavailable", { status: 502 }))
    );
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("Failed to fetch worker intents (HTTP 502)")).toBeDefined();
    });
  });

  it("displays error message on fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeDefined();
    });
  });

  it("does not show count badge when intents list is empty", async () => {
    stubFetch({ data: { intents: [] } });
    renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("No active intents")).toBeDefined();
    });
    expect(screen.queryByText(/active/)).not.toBeNull(); // "No active intents" contains "active"
    expect(screen.queryByText("0 active")).toBeNull();
  });

  it("applies correct status color classes", async () => {
    stubFetch({ data: { intents: [makeIntent({ status: "in_progress" })] } });
    const { container } = renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("in_progress")).toBeDefined();
    });
    const badge = container.querySelector(".text-emerald-400");
    expect(badge).not.toBeNull();
  });

  it("falls back to idle color for unknown status", async () => {
    stubFetch({ data: { intents: [makeIntent({ status: "unknown_status" })] } });
    const { container } = renderWithProvider(<WorkerIntents pollInterval={60000} />);
    await waitFor(() => {
      expect(screen.getByText("unknown_status")).toBeDefined();
    });
    // Should use the idle fallback color
    const badge = container.querySelector(".text-zinc-400");
    expect(badge).not.toBeNull();
  });
});
