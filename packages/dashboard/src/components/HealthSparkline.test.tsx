// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { HealthSparkline } from "./HealthSparkline";
import { SkynetProvider } from "./SkynetProvider";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_TREND = [
  { ts: 1700000000, score: 90 },
  { ts: 1700003600, score: 85 },
  { ts: 1700007200, score: 72 },
  { ts: 1700010800, score: 88 },
];

const MOCK_TREND_LOW = [
  { ts: 1700000000, score: 30 },
  { ts: 1700003600, score: 40 },
];

const MOCK_TREND_MID = [
  { ts: 1700000000, score: 55 },
  { ts: 1700003600, score: 65 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HealthSparkline", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders SVG sparkline with valid trend data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_TREND, error: null }))
    ));

    renderWithProvider(<HealthSparkline />);

    await waitFor(() => {
      const svg = screen.getByLabelText(/Health trend/);
      expect(svg).toBeDefined();
      expect(svg.tagName).toBe("svg");
    });
  });

  it("includes data point count and current score in aria-label", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_TREND, error: null }))
    ));

    renderWithProvider(<HealthSparkline />);

    await waitFor(() => {
      const svg = screen.getByLabelText("Health trend: 4 data points, current 88");
      expect(svg).toBeDefined();
    });
  });

  it("renders nothing when fewer than 2 data points", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ ts: 1700000000, score: 90 }], error: null }))
    ));

    const { container } = renderWithProvider(<HealthSparkline />);

    // Wait for fetch to complete
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    // Should render nothing — no SVG in the DOM
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders nothing when fetch returns empty array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], error: null }))
    ));

    const { container } = renderWithProvider(<HealthSparkline />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    expect(container.querySelector("svg")).toBeNull();
  });

  it("uses green stroke for high scores (>80)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_TREND, error: null }))
    ));

    const { container } = renderWithProvider(<HealthSparkline />);

    await waitFor(() => {
      const polyline = container.querySelector("polyline");
      expect(polyline).not.toBeNull();
      // Last score is 88 → emerald-400 (#34d399)
      expect(polyline?.getAttribute("stroke")).toBe("#34d399");
    });
  });

  it("uses amber stroke for mid-range scores (50-80)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_TREND_MID, error: null }))
    ));

    const { container } = renderWithProvider(<HealthSparkline />);

    await waitFor(() => {
      const polyline = container.querySelector("polyline");
      expect(polyline).not.toBeNull();
      // Last score is 65 → amber-400 (#fbbf24)
      expect(polyline?.getAttribute("stroke")).toBe("#fbbf24");
    });
  });

  it("uses red stroke for low scores (<50)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_TREND_LOW, error: null }))
    ));

    const { container } = renderWithProvider(<HealthSparkline />);

    await waitFor(() => {
      const polyline = container.querySelector("polyline");
      expect(polyline).not.toBeNull();
      // Last score is 40 → red-400 (#f87171)
      expect(polyline?.getAttribute("stroke")).toBe("#f87171");
    });
  });

  it("renders a dot (circle) on the latest value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_TREND, error: null }))
    ));

    const { container } = renderWithProvider(<HealthSparkline />);

    await waitFor(() => {
      const circle = container.querySelector("circle");
      expect(circle).not.toBeNull();
      expect(circle?.getAttribute("fill")).toBe("#34d399");
    });
  });

  it("fetches from the correct API endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_TREND, error: null }))
    ));

    renderWithProvider(<HealthSparkline />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/pipeline/health-trend");
    });
  });

  it("handles fetch errors gracefully (renders nothing)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const { container } = renderWithProvider(<HealthSparkline />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    // Should render nothing on error
    expect(container.querySelector("svg")).toBeNull();
  });

  it("handles non-array response data gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: "not-an-array", error: null }))
    ));

    const { container } = renderWithProvider(<HealthSparkline />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    expect(container.querySelector("svg")).toBeNull();
  });
});
