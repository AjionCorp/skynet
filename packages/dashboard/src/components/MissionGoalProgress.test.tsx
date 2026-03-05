// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MissionGoalProgress } from "./MissionGoalProgress";
import { SkynetProvider } from "./SkynetProvider";
import type { MissionProgress } from "../types";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_PROGRESS: MissionProgress[] = [
  { id: 1, criterion: "Achieve 95% test coverage", status: "met", evidence: "Coverage at 96%" },
  { id: 2, criterion: "All APIs documented", status: "partial", evidence: "80% documented" },
  { id: 3, criterion: "Zero critical bugs", status: "not-met", evidence: "3 critical bugs remain" },
];

const MOCK_BURNDOWN_RESPONSE = {
  data: {
    goals: [
      {
        goalIndex: 0,
        goalText: "Achieve 95% test coverage",
        checked: true,
        relatedCompleted: 5,
        relatedRemaining: 0,
        burndown: [
          { date: "2026-03-01", completed: 2 },
          { date: "2026-03-02", completed: 3 },
          { date: "2026-03-03", completed: 5 },
        ],
        velocityPerDay: 1.5,
        etaDate: null,
        etaDays: null,
      },
      {
        goalIndex: 1,
        goalText: "All APIs documented",
        checked: false,
        relatedCompleted: 4,
        relatedRemaining: 2,
        burndown: [
          { date: "2026-03-01", completed: 1 },
          { date: "2026-03-02", completed: 3 },
          { date: "2026-03-03", completed: 4 },
        ],
        velocityPerDay: 1.0,
        etaDate: "2026-03-05",
        etaDays: 2,
      },
      {
        goalIndex: 2,
        goalText: "Zero critical bugs",
        checked: false,
        relatedCompleted: 1,
        relatedRemaining: 3,
        burndown: [{ date: "2026-03-03", completed: 1 }],
        velocityPerDay: null,
        etaDate: null,
        etaDays: null,
      },
    ],
    overallMissionEta: {
      etaDate: "2026-03-10",
      etaDays: 5,
      confidence: "high" as const,
    },
  },
};

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

describe("MissionGoalProgress", () => {
  beforeEach(() => {
    stubFetch(MOCK_BURNDOWN_RESPONSE);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing when missionProgress is empty", () => {
    const { container } = renderWithProvider(
      <MissionGoalProgress missionProgress={[]} alignmentScore={80} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("displays the header with met/total count", () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={75} />
    );
    expect(screen.getByText("Mission Goal Progress")).toBeDefined();
    expect(screen.getByText("1/3 met")).toBeDefined();
  });

  it("shows partial count badge when there are partial goals", () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={75} />
    );
    expect(screen.getByText("1 partial")).toBeDefined();
  });

  it("hides partial badge when no partial goals exist", () => {
    const progress: MissionProgress[] = [
      { id: 1, criterion: "Goal A", status: "met", evidence: "" },
      { id: 2, criterion: "Goal B", status: "not-met", evidence: "" },
    ];
    renderWithProvider(
      <MissionGoalProgress missionProgress={progress} alignmentScore={50} />
    );
    expect(screen.queryByText(/partial/)).toBeNull();
  });

  it("displays alignment score percentage", () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={75} />
    );
    // Header and alignment bar both show the score
    const matches = screen.getAllByText("75%");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("renders each criterion with its status label", () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={80} />
    );
    expect(screen.getByText("Achieve 95% test coverage")).toBeDefined();
    expect(screen.getByText("Met")).toBeDefined();
    expect(screen.getByText("Partial")).toBeDefined();
    expect(screen.getByText("Not Met")).toBeDefined();
  });

  it("renders evidence text for each criterion", () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={80} />
    );
    expect(screen.getByText("Coverage at 96%")).toBeDefined();
    expect(screen.getByText("80% documented")).toBeDefined();
    expect(screen.getByText("3 critical bugs remain")).toBeDefined();
  });

  it("collapses and expands on header click", () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={80} />
    );
    // Initially expanded — criteria visible
    expect(screen.getByText("Achieve 95% test coverage")).toBeDefined();

    // Click to collapse
    fireEvent.click(screen.getByText("Mission Goal Progress"));
    expect(screen.queryByText("Achieve 95% test coverage")).toBeNull();

    // Click to expand again
    fireEvent.click(screen.getByText("Mission Goal Progress"));
    expect(screen.getByText("Achieve 95% test coverage")).toBeDefined();
  });

  it("fetches burndown data from the correct endpoint", async () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={80} />
    );
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/mission/goal-burndown");
    });
  });

  it("displays burndown task counts after fetch", async () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={80} />
    );
    await waitFor(() => {
      expect(screen.getByText(/5 done/)).toBeDefined();
    });
    expect(screen.getByText(/4 done/)).toBeDefined();
  });

  it("displays remaining task counts", async () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={80} />
    );
    await waitFor(() => {
      expect(screen.getByText(/2 remaining/)).toBeDefined();
      expect(screen.getByText(/3 remaining/)).toBeDefined();
    });
  });

  it("shows velocity when available", async () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={80} />
    );
    await waitFor(() => {
      expect(screen.getByText("1.5/day")).toBeDefined();
      expect(screen.getByText("1/day")).toBeDefined();
    });
  });

  it("renders ETA badge for goals with ETA data", async () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={80} />
    );
    await waitFor(() => {
      expect(screen.getByText(/ETA: ~2 days/)).toBeDefined();
    });
  });

  it("renders overall mission ETA in the header", async () => {
    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={80} />
    );
    await waitFor(() => {
      expect(screen.getByText(/ETA: ~5 days/)).toBeDefined();
    });
  });

  it("renders SVG sparklines for goals with burndown data", async () => {
    const { container } = renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={80} />
    );
    await waitFor(() => {
      // Goals 0 and 1 have >= 2 burndown points → 2 sparkline <path> elements
      const paths = container.querySelectorAll("svg path[fill='none']");
      expect(paths.length).toBe(2);
    });
  });

  it("handles fetch error gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={80} />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    // Component should still render criteria without burndown data
    expect(screen.getByText("Achieve 95% test coverage")).toBeDefined();
    expect(screen.getByText("Met")).toBeDefined();
  });

  it("uses emerald alignment color for score >= 80", () => {
    const { container } = renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={85} />
    );
    const bar = container.querySelector(".bg-emerald-500");
    expect(bar).not.toBeNull();
  });

  it("uses amber alignment color for score 50-79", () => {
    const { container } = renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={65} />
    );
    const bar = container.querySelector(".bg-amber-500");
    expect(bar).not.toBeNull();
  });

  it("uses red alignment color for score < 50", () => {
    const { container } = renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={30} />
    );
    const bar = container.querySelector(".bg-red-500");
    expect(bar).not.toBeNull();
  });

  it("sets alignment bar width based on score", () => {
    const { container } = renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={75} />
    );
    const bar = container.querySelector(".bg-amber-500") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.style.width).toBe("75%");
  });

  it("caps alignment bar width at 100%", () => {
    const { container } = renderWithProvider(
      <MissionGoalProgress missionProgress={MOCK_PROGRESS} alignmentScore={120} />
    );
    const bar = container.querySelector(".bg-emerald-500") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.style.width).toBe("100%");
  });
});
