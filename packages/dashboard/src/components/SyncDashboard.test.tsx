// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { SyncDashboard } from "./SyncDashboard";
import { SkynetProvider } from "./SkynetProvider";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_PIPELINE_STATUS = {
  syncHealth: [
    { endpoint: "civic_data", status: "ok", records: "1,234", notes: "Full sync", lastRun: "2024-01-01T00:00:00Z" },
    { endpoint: "voter_rolls", status: "error", records: "0", notes: "Connection timeout", lastRun: "2024-01-01T00:00:00Z" },
    { endpoint: "ballot_info", status: "ok", records: "567", notes: "Incremental", lastRun: "2024-01-01T00:00:00Z" },
  ],
};

const MOCK_EMPTY_STATUS = {
  syncHealth: [],
};

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockFetchWith(data: Record<string, unknown> | null, error: string | null = null) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data, error }))
  ));
}

describe("SyncDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderWithProvider(<SyncDashboard />);
    expect(screen.getByText("Loading sync status...")).toBeDefined();
  });

  it("renders sync health status with summary cards", async () => {
    mockFetchWith(MOCK_PIPELINE_STATUS);
    renderWithProvider(<SyncDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Endpoints")).toBeDefined();
    });
    expect(screen.getByText("Healthy")).toBeDefined();
    expect(screen.getByText("Errors")).toBeDefined();
    expect(screen.getByText("Syncing")).toBeDefined();
  });

  it("renders correct endpoint counts", async () => {
    mockFetchWith(MOCK_PIPELINE_STATUS);
    renderWithProvider(<SyncDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Endpoints")).toBeDefined();
    });
    // 3 total endpoints
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1);
    // 2 healthy (ok status)
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
    // 1 error
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(1);
  });

  it("shows 'No sync endpoints configured' when empty", async () => {
    mockFetchWith(MOCK_EMPTY_STATUS);
    renderWithProvider(<SyncDashboard />);
    await waitFor(() => {
      expect(screen.getByText("No sync endpoints configured")).toBeDefined();
    });
    expect(screen.getByText("Add SKYNET_SYNC_ENDPOINTS to your skynet.project.sh")).toBeDefined();
  });

  it("displays endpoint statuses with correct badges", async () => {
    mockFetchWith(MOCK_PIPELINE_STATUS);
    renderWithProvider(<SyncDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Civic Data")).toBeDefined();
    });
    expect(screen.getByText("Voter Rolls")).toBeDefined();
    expect(screen.getByText("Ballot Info")).toBeDefined();
    // Success badges for ok endpoints
    const successBadges = screen.getAllByText("Success");
    expect(successBadges.length).toBe(2);
    // Error badge
    expect(screen.getByText("Error")).toBeDefined();
  });

  it("displays error message for errored endpoints", async () => {
    mockFetchWith(MOCK_PIPELINE_STATUS);
    renderWithProvider(<SyncDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Connection timeout")).toBeDefined();
    });
  });

  it("displays record counts", async () => {
    mockFetchWith(MOCK_PIPELINE_STATUS);
    renderWithProvider(<SyncDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Civic Data")).toBeDefined();
    });
    // 1,234 records
    expect(screen.getAllByText("1,234").length).toBeGreaterThanOrEqual(1);
    // 567 records
    expect(screen.getAllByText("567").length).toBeGreaterThanOrEqual(1);
  });

  it("shows error banner when API returns error", async () => {
    mockFetchWith(null, "Pipeline status unavailable");
    renderWithProvider(<SyncDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Pipeline status unavailable")).toBeDefined();
    });
  });

  it("fetches from correct API endpoint", async () => {
    mockFetchWith(MOCK_PIPELINE_STATUS);
    renderWithProvider(<SyncDashboard />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/pipeline/status");
    });
  });

  it("renders Refresh button", async () => {
    mockFetchWith(MOCK_PIPELINE_STATUS);
    renderWithProvider(<SyncDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Refresh")).toBeDefined();
    });
  });

  it("supports custom endpoints prop", async () => {
    mockFetchWith(MOCK_PIPELINE_STATUS);
    const customEndpoints = [
      { apiName: "civic_data", label: "Civic Data API", description: "Main civic data source" },
    ];
    renderWithProvider(<SyncDashboard endpoints={customEndpoints} />);
    await waitFor(() => {
      expect(screen.getByText("Civic Data API")).toBeDefined();
    });
    expect(screen.getByText("Main civic data source")).toBeDefined();
    // Only 1 endpoint configured
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(1);
  });
});
