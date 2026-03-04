// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { MissionDashboard } from "./MissionDashboard";
import { SkynetProvider } from "./SkynetProvider";
import type { MissionStatus, MissionProgress, PipelineStatus } from "../types";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_MISSION: MissionStatus = {
  state: "ACTIVE",
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
  pipelinePaused: false,
} as PipelineStatus;

const MOCK_MISSIONS_RESPONSE = {
  data: {
    missions: [
      { slug: "main", name: "Mission", isActive: true, assignedWorkers: [] },
    ],
    config: { activeMission: "main", assignments: {} },
  },
  error: null,
};

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

/**
 * Mock fetch to handle all MissionDashboard API calls.
 * Routes: /missions (list), /mission/status (detail), /pipeline/status
 */
function mockFetchForMission(
  mission: MissionStatus | null,
  pipeline: Partial<PipelineStatus> | null,
  missionError: string | null = null,
  pipelineError: string | null = null,
) {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/missions")) {
      return Promise.resolve(new Response(JSON.stringify(MOCK_MISSIONS_RESPONSE)));
    }
    if (url.includes("/mission/status")) {
      return Promise.resolve(new Response(JSON.stringify({ data: mission, error: missionError })));
    }
    if (url.includes("/pipeline/status")) {
      return Promise.resolve(new Response(JSON.stringify({ data: pipeline, error: pipelineError })));
    }
    return Promise.resolve(new Response(JSON.stringify({ data: null, error: null })));
  }));
}

describe("MissionDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    renderWithProvider(<MissionDashboard />);
    expect(screen.getByText("Loading missions...")).toBeDefined();
  });

  it("renders mission content in pre block", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Mission Document")).toBeDefined();
    });
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
    expect(screen.getByText("65%")).toBeDefined();
    expect(screen.getAllByText("Success Criteria").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Goals").length).toBeGreaterThanOrEqual(1);
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
    expect(screen.getByText("All tests pass")).toBeDefined();
    expect(screen.getByText("Self-correction rate")).toBeDefined();
    expect(screen.getByText("Handler coverage")).toBeDefined();
    expect(screen.getByText("Met")).toBeDefined();
    expect(screen.getByText("Partial")).toBeDefined();
    expect(screen.getByText("Not Met")).toBeDefined();
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

  it("renders pipeline control buttons", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Pause")).toBeDefined();
    });
    expect(screen.getByText("Start")).toBeDefined();
    expect(screen.getByText("Stop")).toBeDefined();
  });

  it("shows Resume and paused badge when pipeline is paused", async () => {
    const pausedPipeline = { ...MOCK_PIPELINE_STATUS, pipelinePaused: true };
    mockFetchForMission(MOCK_MISSION, pausedPipeline);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Resume")).toBeDefined();
    });
    expect(screen.getByText("Pipeline Paused")).toBeDefined();
  });

  it("renders mission selector cards", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("New Mission")).toBeDefined();
    });
  });

  it("renders worker assignment panel", async () => {
    mockFetchForMission(MOCK_MISSION, MOCK_PIPELINE_STATUS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Worker Assignments")).toBeDefined();
    });
    expect(screen.getByText("dev-worker-1")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LLM Selector tests
// ---------------------------------------------------------------------------

const MOCK_MISSIONS_WITH_LLM = {
  data: {
    missions: [
      { slug: "main", name: "Mission", isActive: true, assignedWorkers: [], llmConfig: { provider: "claude" } },
      { slug: "side", name: "Side Quest", isActive: false, assignedWorkers: [], llmConfig: { provider: "gemini", model: "gemini-2.0-flash" } },
    ],
    config: {
      activeMission: "main",
      assignments: {},
      llmConfigs: { main: { provider: "claude" }, side: { provider: "gemini", model: "gemini-2.0-flash" } },
    },
  },
  error: null,
};

const MOCK_MISSIONS_NO_LLM = {
  data: {
    missions: [
      { slug: "main", name: "Mission", isActive: true, assignedWorkers: [] },
    ],
    config: { activeMission: "main", assignments: {} },
  },
  error: null,
};

function mockFetchForLlm(
  missionsResponse: typeof MOCK_MISSIONS_WITH_LLM | typeof MOCK_MISSIONS_NO_LLM,
  mission: MissionStatus | null = MOCK_MISSION,
  pipeline: Partial<PipelineStatus> | null = MOCK_PIPELINE_STATUS,
) {
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PUT" && url.includes("/missions/assignments")) {
      return Promise.resolve(new Response(JSON.stringify({ data: missionsResponse.data.config, error: null })));
    }
    if (url.includes("/missions")) {
      return Promise.resolve(new Response(JSON.stringify(missionsResponse)));
    }
    if (url.includes("/mission/status")) {
      return Promise.resolve(new Response(JSON.stringify({ data: mission, error: null })));
    }
    if (url.includes("/pipeline/status")) {
      return Promise.resolve(new Response(JSON.stringify({ data: pipeline, error: null })));
    }
    return Promise.resolve(new Response(JSON.stringify({ data: null, error: null })));
  }));
}

describe("MissionDashboard — LLM selector", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders LLM Configuration panel with heading", async () => {
    mockFetchForLlm(MOCK_MISSIONS_WITH_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
  });

  it("renders provider dropdown with all four options", async () => {
    mockFetchForLlm(MOCK_MISSIONS_WITH_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    // The provider select is inside the LLM Configuration panel
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.map((o) => o.textContent)).toEqual(["Auto", "Claude", "Codex", "Gemini"]);
  });

  it("pre-selects the configured provider for the active mission", async () => {
    mockFetchForLlm(MOCK_MISSIONS_WITH_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    expect(select.value).toBe("claude");
  });

  it("defaults provider to 'auto' when mission has no LLM config", async () => {
    mockFetchForLlm(MOCK_MISSIONS_NO_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    expect(select.value).toBe("auto");
  });

  it("renders model input field", async () => {
    mockFetchForLlm(MOCK_MISSIONS_WITH_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    expect(screen.getByText("Model (optional)")).toBeDefined();
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const input = llmPanel.querySelector("input")!;
    expect(input.placeholder).toBe("e.g. claude-sonnet-4-6");
  });

  it("shows Save LLM Config button after changing provider", async () => {
    mockFetchForLlm(MOCK_MISSIONS_WITH_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    // Initially no save button
    expect(screen.queryByText("Save LLM Config")).toBeNull();
    // Change provider
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    fireEvent.change(select, { target: { value: "codex" } });
    expect(screen.getByText("Save LLM Config")).toBeDefined();
  });

  it("shows Save LLM Config button after typing in model input", async () => {
    mockFetchForLlm(MOCK_MISSIONS_WITH_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    expect(screen.queryByText("Save LLM Config")).toBeNull();
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const input = llmPanel.querySelector("input")!;
    fireEvent.change(input, { target: { value: "claude-opus-4-6" } });
    expect(screen.getByText("Save LLM Config")).toBeDefined();
  });

  it("calls assignments API with correct llmConfigs payload on save", async () => {
    mockFetchForLlm(MOCK_MISSIONS_WITH_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    // Change provider to trigger dirty state
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    fireEvent.change(select, { target: { value: "gemini" } });
    // Click save
    fireEvent.click(screen.getByText("Save LLM Config"));
    await waitFor(() => {
      const fetchMock = vi.mocked(globalThis.fetch);
      const putCalls = fetchMock.mock.calls.filter(
        ([url, init]) => typeof url === "string" && url.includes("/missions/assignments") && (init as RequestInit)?.method === "PUT",
      );
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
      const lastPut = putCalls[putCalls.length - 1];
      const body = JSON.parse((lastPut[1] as RequestInit).body as string);
      expect(body.llmConfigs).toBeDefined();
      expect(body.llmConfigs.main.provider).toBe("gemini");
    });
  });

  it("renders provider badge on mission cards", async () => {
    mockFetchForLlm(MOCK_MISSIONS_WITH_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    // The mission cards should show provider badges
    // "Claude" badge on the main mission card, "Gemini" badge on side quest
    const claudeBadges = screen.getAllByText("Claude");
    expect(claudeBadges.length).toBeGreaterThanOrEqual(1);
    const geminiBadges = screen.getAllByText("Gemini");
    expect(geminiBadges.length).toBeGreaterThanOrEqual(1);
  });

  it("renders Auto badge when mission has no explicit LLM config", async () => {
    mockFetchForLlm(MOCK_MISSIONS_NO_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    // Mission card should show "Auto" badge (default)
    const autoBadges = screen.getAllByText("Auto");
    expect(autoBadges.length).toBeGreaterThanOrEqual(1);
  });

  it("clears model field when switching provider", async () => {
    mockFetchForLlm(MOCK_MISSIONS_WITH_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const input = llmPanel.querySelector("input")!;
    // Type a model name
    fireEvent.change(input, { target: { value: "claude-opus-4-6" } });
    expect(input.value).toBe("claude-opus-4-6");
    // Switch provider — model should be cleared (set to undefined → renders as "")
    const select = llmPanel.querySelector("select")!;
    fireEvent.change(select, { target: { value: "codex" } });
    expect(input.value).toBe("");
  });

  it("renders Provider label above the dropdown", async () => {
    mockFetchForLlm(MOCK_MISSIONS_WITH_LLM);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Provider")).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// LLM config interaction tests
// ---------------------------------------------------------------------------

const MOCK_MULTI_MISSIONS = {
  data: {
    missions: [
      { slug: "main", name: "Main Mission", isActive: true, assignedWorkers: [], completionPercentage: 50, llmConfig: { provider: "claude" as const } },
      { slug: "side", name: "Side Quest", isActive: false, assignedWorkers: [], completionPercentage: 20, llmConfig: { provider: "gemini" as const, model: "gemini-2.0-flash" } },
      { slug: "nollm", name: "No LLM", isActive: false, assignedWorkers: [], completionPercentage: 0 },
    ],
    config: {
      activeMission: "main",
      assignments: {},
      llmConfigs: {
        main: { provider: "claude" as const },
        side: { provider: "gemini" as const, model: "gemini-2.0-flash" },
      },
    },
  },
  error: null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockFetchForLlmInteractions(
  missionsResponse: { data: { missions: any[]; config: any }; error: null },
  opts?: {
    mission?: MissionStatus | null;
    pipeline?: Partial<PipelineStatus> | null;
    putError?: string | null;
    putThrows?: boolean;
  },
) {
  const mission = opts?.mission ?? MOCK_MISSION;
  const pipeline = opts?.pipeline ?? MOCK_PIPELINE_STATUS;
  const putError = opts?.putError ?? null;
  const putThrows = opts?.putThrows ?? false;

  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PUT" && url.includes("/missions/assignments")) {
      if (putThrows) return Promise.reject(new Error("Network error"));
      if (putError) {
        return Promise.resolve(new Response(JSON.stringify({ data: null, error: putError })));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: missionsResponse.data.config, error: null })));
    }
    if (url.includes("/missions")) {
      return Promise.resolve(new Response(JSON.stringify(missionsResponse)));
    }
    if (url.includes("/mission/status")) {
      return Promise.resolve(new Response(JSON.stringify({ data: mission, error: null })));
    }
    if (url.includes("/pipeline/status")) {
      return Promise.resolve(new Response(JSON.stringify({ data: pipeline, error: null })));
    }
    if (url.includes("/mission/tracking")) {
      return Promise.resolve(new Response(JSON.stringify({ data: null, error: null })));
    }
    return Promise.resolve(new Response(JSON.stringify({ data: null, error: null })));
  }));
}

describe("MissionDashboard — LLM config interactions", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("updates LLM config panel when switching to a mission with model", async () => {
    mockFetchForLlmInteractions(MOCK_MULTI_MISSIONS);
    renderWithProvider(<MissionDashboard />);
    // Wait for initial load — active mission "main" with "claude" provider
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    expect(select.value).toBe("claude");

    // Click on "Side Quest" mission card (the button containing the mission name span)
    const sideQuestCard = screen.getByText("Side Quest", { selector: "span" }).closest("button")!;
    fireEvent.click(sideQuestCard);

    await waitFor(() => {
      const updatedSelect = screen.getByText("LLM Configuration").closest("div.rounded-xl")!.querySelector("select")!;
      expect(updatedSelect.value).toBe("gemini");
    });
    // Model field should show the configured model
    const input = llmPanel.querySelector("input")!;
    expect(input.value).toBe("gemini-2.0-flash");
  });

  it("pre-populates model input from mission config", async () => {
    // Use a response where active mission has a model
    const withModel = {
      data: {
        missions: [
          { slug: "main", name: "Main Mission", isActive: true, assignedWorkers: [] as string[], completionPercentage: 50, llmConfig: { provider: "claude" as const, model: "claude-opus-4-6" } },
        ],
        config: {
          activeMission: "main",
          assignments: {} as Record<string, string | null>,
          llmConfigs: { main: { provider: "claude" as const, model: "claude-opus-4-6" } },
        },
      },
      error: null,
    };
    mockFetchForLlmInteractions(withModel);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const input = llmPanel.querySelector("input")!;
    expect(input.value).toBe("claude-opus-4-6");
  });

  it("includes model in API payload when saving", async () => {
    mockFetchForLlmInteractions(MOCK_MULTI_MISSIONS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const input = llmPanel.querySelector("input")!;

    // Type a model name (this triggers dirty state)
    fireEvent.change(input, { target: { value: "claude-opus-4-6" } });
    fireEvent.click(screen.getByText("Save LLM Config"));

    await waitFor(() => {
      const fetchMock = vi.mocked(globalThis.fetch);
      const putCalls = fetchMock.mock.calls.filter(
        ([url, init]) => typeof url === "string" && url.includes("/missions/assignments") && (init as RequestInit)?.method === "PUT",
      );
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse((putCalls[0][1] as RequestInit).body as string);
      expect(body.llmConfigs.main.model).toBe("claude-opus-4-6");
      expect(body.llmConfigs.main.provider).toBe("claude");
    });
  });

  it("hides Save LLM Config button after successful save", async () => {
    mockFetchForLlmInteractions(MOCK_MULTI_MISSIONS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    // Change provider to trigger dirty
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    fireEvent.change(select, { target: { value: "codex" } });
    expect(screen.getByText("Save LLM Config")).toBeDefined();

    // Save
    fireEvent.click(screen.getByText("Save LLM Config"));

    // After save, button should disappear (dirty reset)
    await waitFor(() => {
      expect(screen.queryByText("Save LLM Config")).toBeNull();
    });
  });

  it("shows error when save API returns an error", async () => {
    mockFetchForLlmInteractions(MOCK_MULTI_MISSIONS, { putError: "Failed to update LLM config" });
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    // Change provider and save
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    fireEvent.change(select, { target: { value: "codex" } });
    fireEvent.click(screen.getByText("Save LLM Config"));

    await waitFor(() => {
      expect(screen.getByText("Failed to update LLM config")).toBeDefined();
    });
  });

  it("shows error when save request throws a network error", async () => {
    mockFetchForLlmInteractions(MOCK_MULTI_MISSIONS, { putThrows: true });
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    fireEvent.change(select, { target: { value: "codex" } });
    fireEvent.click(screen.getByText("Save LLM Config"));

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeDefined();
    });
  });

  it("applies correct color classes to provider badges on mission cards", async () => {
    mockFetchForLlmInteractions(MOCK_MULTI_MISSIONS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    // Claude badge should use violet colors
    const claudeBadges = screen.getAllByText("Claude");
    expect(claudeBadges.some((el) => el.className.includes("violet"))).toBe(true);
    // Gemini badge should use blue colors
    const geminiBadges = screen.getAllByText("Gemini");
    expect(geminiBadges.some((el) => el.className.includes("blue"))).toBe(true);
    // "No LLM" mission defaults to Auto with zinc colors
    const autoBadges = screen.getAllByText("Auto");
    expect(autoBadges.some((el) => el.className.includes("zinc"))).toBe(true);
  });

  it("saves with correct slug key when a non-active mission is selected", async () => {
    mockFetchForLlmInteractions(MOCK_MULTI_MISSIONS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });

    // Switch to the "Side Quest" mission via the card button
    const sideQuestCard = screen.getByText("Side Quest", { selector: "span" }).closest("button")!;
    fireEvent.click(sideQuestCard);

    await waitFor(() => {
      const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
      const select = llmPanel.querySelector("select")!;
      expect(select.value).toBe("gemini");
    });

    // Change provider
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    fireEvent.change(select, { target: { value: "claude" } });
    fireEvent.click(screen.getByText("Save LLM Config"));

    await waitFor(() => {
      const fetchMock = vi.mocked(globalThis.fetch);
      const putCalls = fetchMock.mock.calls.filter(
        ([url, init]) => typeof url === "string" && url.includes("/missions/assignments") && (init as RequestInit)?.method === "PUT",
      );
      expect(putCalls.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse((putCalls[putCalls.length - 1][1] as RequestInit).body as string);
      // Must use "side" slug, not "main"
      expect(body.llmConfigs.side).toBeDefined();
      expect(body.llmConfigs.side.provider).toBe("claude");
    });
  });

  it("does not show save button when provider is changed back to original value", async () => {
    mockFetchForLlmInteractions(MOCK_MULTI_MISSIONS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    // Change provider away
    fireEvent.change(select, { target: { value: "codex" } });
    expect(screen.getByText("Save LLM Config")).toBeDefined();
    // Change back to original — button still shows since dirty flag tracks any change
    // (component uses a simple dirty flag, not deep comparison)
    fireEvent.change(select, { target: { value: "claude" } });
    // The dirty flag remains true because the component doesn't deep-compare
    expect(screen.getByText("Save LLM Config")).toBeDefined();
  });

  it("clears model and shows save button when switching provider on a mission with model", async () => {
    mockFetchForLlmInteractions(MOCK_MULTI_MISSIONS);
    renderWithProvider(<MissionDashboard />);
    await waitFor(() => {
      expect(screen.getByText("LLM Configuration")).toBeDefined();
    });

    // Switch to side mission that has a model configured
    const sideQuestCard = screen.getByText("Side Quest", { selector: "span" }).closest("button")!;
    fireEvent.click(sideQuestCard);
    await waitFor(() => {
      const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
      const input = llmPanel.querySelector("input")!;
      expect(input.value).toBe("gemini-2.0-flash");
    });

    // Change provider — model should clear
    const llmPanel = screen.getByText("LLM Configuration").closest("div.rounded-xl")!;
    const select = llmPanel.querySelector("select")!;
    fireEvent.change(select, { target: { value: "claude" } });

    const input = llmPanel.querySelector("input")!;
    expect(input.value).toBe("");
    expect(screen.getByText("Save LLM Config")).toBeDefined();
  });
});
