// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { TaskVelocityChart } from "./TaskVelocityChart";
import { SkynetProvider } from "./SkynetProvider";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_VELOCITY = [
  { date: "2024-01-01", count: 3, avgDurationMins: 45 },
  { date: "2024-01-02", count: 5, avgDurationMins: 30 },
  { date: "2024-01-03", count: 2, avgDurationMins: 60 },
  { date: "2024-01-04", count: 7, avgDurationMins: null },
  { date: "2024-01-05", count: 4, avgDurationMins: 50 },
];

const MOCK_SINGLE_DAY = [
  { date: "2024-01-01", count: 3, avgDurationMins: 45 },
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

describe("TaskVelocityChart", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the chart title and SVG with velocity data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_VELOCITY, error: null }))
    ));

    renderWithProvider(<TaskVelocityChart />);

    await waitFor(() => {
      expect(screen.getByText("Task Completion Velocity")).toBeDefined();
    });

    const svg = screen.getByLabelText(/Task velocity/);
    expect(svg).toBeDefined();
    expect(svg.tagName).toBe("svg");
  });

  it("displays correct aria-label with day count and max tasks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_VELOCITY, error: null }))
    ));

    renderWithProvider(<TaskVelocityChart />);

    await waitFor(() => {
      const svg = screen.getByLabelText("Task velocity: 5 days, max 7 tasks/day");
      expect(svg).toBeDefined();
    });
  });

  it("renders nothing when no data is available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], error: null }))
    ));

    const { container } = renderWithProvider(<TaskVelocityChart />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    expect(container.querySelector("svg")).toBeNull();
  });

  it("shows date labels in MM-DD format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_VELOCITY, error: null }))
    ));

    renderWithProvider(<TaskVelocityChart />);

    await waitFor(() => {
      expect(screen.getByText("01-01")).toBeDefined();
      expect(screen.getByText("01-05")).toBeDefined();
    });
  });

  it("shows count labels above non-zero bars", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_VELOCITY, error: null }))
    ));

    renderWithProvider(<TaskVelocityChart />);

    await waitFor(() => {
      expect(screen.getByText("7")).toBeDefined();
      expect(screen.getByText("5")).toBeDefined();
    });
  });

  it("renders summary line with total tasks and day count", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_VELOCITY, error: null }))
    ));

    renderWithProvider(<TaskVelocityChart />);

    // Total: 3+5+2+7+4 = 21 tasks over 5 days
    await waitFor(() => {
      expect(screen.getByText(/Total: 21 tasks over 5 days/)).toBeDefined();
    });
  });

  it("shows average per day when 2+ data points", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_VELOCITY, error: null }))
    ));

    renderWithProvider(<TaskVelocityChart />);

    // Avg: round(21/5) = 4/day
    await waitFor(() => {
      expect(screen.getByText(/Avg: 4\/day/)).toBeDefined();
    });
  });

  it("omits average when only 1 data point", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_SINGLE_DAY, error: null }))
    ));

    renderWithProvider(<TaskVelocityChart />);

    await waitFor(() => {
      expect(screen.getByText(/Total: 3 tasks over 1 day$/)).toBeDefined();
    });

    // No "Avg:" text should appear
    expect(screen.queryByText(/Avg:/)).toBeNull();
  });

  it("does not render count labels for zero-count bars", async () => {
    const dataWithZero = [
      { date: "2024-01-01", count: 0, avgDurationMins: null },
      { date: "2024-01-02", count: 3, avgDurationMins: 30 },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: dataWithZero, error: null }))
    ));

    const { container } = renderWithProvider(<TaskVelocityChart />);

    await waitFor(() => {
      expect(screen.getByText("3")).toBeDefined();
    });

    // The bars (rect elements) should still both render
    const rects = container.querySelectorAll("rect");
    expect(rects.length).toBe(2);
  });

  it("fetches from the correct API endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_VELOCITY, error: null }))
    ));

    renderWithProvider(<TaskVelocityChart />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/pipeline/task-velocity");
    });
  });

  it("handles fetch errors gracefully (renders nothing)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const { container } = renderWithProvider(<TaskVelocityChart />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders grid lines within the SVG", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: MOCK_VELOCITY, error: null }))
    ));

    const { container } = renderWithProvider(<TaskVelocityChart />);

    await waitFor(() => {
      // 4 grid lines at 0.25, 0.5, 0.75, 1 fractions
      const lines = container.querySelectorAll("line");
      expect(lines.length).toBe(4);
    });
  });
});
