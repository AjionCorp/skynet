// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MissionDashboard } from "./MissionDashboard";
import { SkynetProvider } from "./SkynetProvider";
import type { MissionStatus, MissionProgress, PipelineStatus } from "../types";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_MISSION: MissionStatus = {
  purpose: "Build the best autonomous pipeline",
  goals: [
    { text: "Automate all deployments", completed: true },
    { text: "Add real-time monitoring", completed: false },
    { text: "Achieve zero downtime", completed: true },
  ],
  successCriteria: [
    { text: "All tests pass on every merge", completed: true },
    { text: "Self-correction rate above 90%", completed: false },
    { text: "Complete handler test coverage", completed: true },
  ],
  currentFocus: "Setting up CI/CD integration",
  completionPercentage: 65,
  raw: "# Mission\nBuild the best autonomous pipeline\n\n## Purpose\nAutomate everything",
};

const MOCK_PROGRESS: MissionProgress[] = [
  { id: 1, criterion: "All tests pass", status: "met", evidence: "100% pass rate" },
  { id: 2, criterion: "Self-correction rate", status: "partial", evidence: "85% current rate" },
  { id: 3, criterion: "Handler coverage", status: "not-met", evidence: "3 of 12 handlers tested" },
];

const MOCK_PIPELINE_STATUS = {
  missionProgress: MOCK_PROGRESS,
} as PipelineStatus;

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockFetchForMission(
  mission: MissionStatus | null,
  pipeline: Partial<PipelineStatus> | null,
  missionError: string | null = null,
  pipelineError: string | null = null,
) {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: mission, error: missionError })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: pipeline, error: pipelineError }))));
}

describe("MissionDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderWithProvider(<MissionDashboard />);
    expect(screen.getByText("Loading mission status...")).toBeDefined();
  });

  it("renders mission content in pre block", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Mission Document")).toBeDefined();
    });
    // Raw mission content is in a <pre> tag
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("# Mission");
    expect(pre!.textContent).toContain("Build the best autonomous pipeline");
  });

  it("renders progress summary cards", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Mission Progress")).toBeDefined();
    });
    // Completion percentage
    expect(screen.getByText("65%")).toBeDefined();
    // Success Criteria and Goals appear in both summary cards and section headings
    expect(screen.getAllByText("Success Criteria").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Goals").length).toBeGreaterThanOrEqual(1);
    // Status: In Progress (not 100%)
    expect(screen.getByText("In Progress")).toBeDefined();
  });

  it("shows Complete status when 100%", async () => {
    const complete = { ...MOCK_MISSION, completionPercentage: 100 };
    mockFetchForMission(complete, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Complete")).toBeDefined();
    });
  });

  it("renders progress table with met/partial/not-met badges", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Progress by Criterion")).toBeDefined();
    });
    // Criterion text
    expect(screen.getByText("All tests pass")).toBeDefined();
    expect(screen.getByText("Self-correction rate")).toBeDefined();
    expect(screen.getByText("Handler coverage")).toBeDefined();
    // Status badges
    expect(screen.getByText("Met")).toBeDefined();
    expect(screen.getByText("Partial")).toBeDefined();
    expect(screen.getByText("Not Met")).toBeDefined();
    // Evidence
    expect(screen.getByText("100% pass rate")).toBeDefined();
    expect(screen.getByText("85% current rate")).toBeDefined();
  });

  it("applies correct colors to status badges", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Met")).toBeDefined();
    });
    expect(screen.getByText("Met").className).toContain("emerald");
    expect(screen.getByText("Partial").className).toContain("amber");
    expect(screen.getByText("Not Met").className).toContain("red");
  });

  it("renders purpose section", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Purpose")).toBeDefined();
    });
    expect(screen.getByText("Build the best autonomous pipeline")).toBeDefined();
  });

  it("renders success criteria list", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("All tests pass on every merge")).toBeDefined();
    });
    expect(screen.getByText("Self-correction rate above 90%")).toBeDefined();
    expect(screen.getByText("Complete handler test coverage")).toBeDefined();
    // Shows count
    expect(screen.getByText(/2 of 3 met/)).toBeDefined();
  });

  it("renders goals list", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Automate all deployments")).toBeDefined();
    });
    expect(screen.getByText("Add real-time monitoring")).toBeDefined();
    expect(screen.getByText("Achieve zero downtime")).toBeDefined();
    expect(screen.getByText(/2 of 3 achieved/)).toBeDefined();
  });

  it("renders current focus section", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Current Focus")).toBeDefined();
    });
    expect(screen.getByText("Setting up CI/CD integration")).toBeDefined();
  });

  it("shows empty state when no mission is defined", async () => {
    const noRaw = { ...MOCK_MISSION, raw: "" };
    mockFetchForMission(noRaw, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("No mission defined")).toBeDefined();
    });
  });

  it("fetches from correct API endpoints", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
    expect(global.fetch).toHaveBeenCalledWith("/api/admin/mission/status");
    expect(global.fetch).toHaveBeenCalledWith("/api/admin/pipeline/status");
  });

  it("shows error banner when mission API returns error", async () => {
    mockFetchForMission(null, MOCK_PIPELINE_STATUS, "Mission file not found");
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Mission file not found")).toBeDefined();
    });
  });

  it("renders Refresh button", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Refresh")).toBeDefined();
    });
  });
});
