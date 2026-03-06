// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { TasksDashboard } from "./TasksDashboard";
import { SkynetProvider } from "./SkynetProvider";
import type { TaskBacklogData } from "../types";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_BACKLOG: TaskBacklogData = {
  items: [
    { text: "[FEAT] Add login page", tag: "FEAT", status: "pending", blockedBy: [], blocked: false },
    { text: "[FIX] Fix auth bug", tag: "FIX", status: "claimed", blockedBy: [], blocked: false },
    { text: "[TEST] Add unit tests", tag: "TEST", status: "pending", blockedBy: ["Fix auth bug"], blocked: true },
  ],
  pendingCount: 5,
  claimedCount: 2,
  manualDoneCount: 10,
};

const MOCK_MISSIONS_RESPONSE = {
  missions: [
    {
      slug: "mission-alpha",
      name: "Mission Alpha",
      isActive: true,
      assignedWorkers: [],
      completionPercentage: 0,
    },
  ],
  config: {
    activeMission: "mission-alpha",
  },
};

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockFetchWith(data: TaskBacklogData | null, error: string | null = null, postData: Record<string, unknown> | null = { position: "top" }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/missions")) {
      return new Response(JSON.stringify({ data: MOCK_MISSIONS_RESPONSE, error: null }));
    }
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ data: postData, error: null }));
    }
    return new Response(JSON.stringify({ data, error }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("TasksDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading spinner initially", () => {
    // Never-resolving fetch to keep loading state
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderWithProvider(<TasksDashboard />);
    // The loading state shows a spinner (Loader2 with animate-spin)
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeDefined();
    expect(spinner).not.toBeNull();
  });

  it("renders pending/claimed/completed counts from mock data", async () => {
    mockFetchWith(MOCK_BACKLOG);
    renderWithProvider(<TasksDashboard />);
    await waitFor(() => {
      expect(screen.getByText("5")).toBeDefined();
    });
    expect(screen.getByText("Pending")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("Claimed")).toBeDefined();
    expect(screen.getByText("10")).toBeDefined();
    expect(screen.getByText("Completed")).toBeDefined();
  });

  it("shows em-dash while loading counts", () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderWithProvider(<TasksDashboard />);
    const dashes = screen.getAllByText("\u2014");
    // 3 summary cards should show em-dash
    expect(dashes.length).toBeGreaterThanOrEqual(3);
  });

  it("renders task list with correct status badges", async () => {
    mockFetchWith(MOCK_BACKLOG);
    renderWithProvider(<TasksDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Add login page")).toBeDefined();
    });
    expect(screen.getByText("Fix auth bug")).toBeDefined();

    // Status badges
    const pendingBadges = screen.getAllByText("pending");
    expect(pendingBadges.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("claimed")).toBeDefined();
  });

  it("renders tag badges with correct tag text", async () => {
    mockFetchWith(MOCK_BACKLOG);
    renderWithProvider(<TasksDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Add login page")).toBeDefined();
    });
    // Tag badges in the backlog items
    const featBadges = screen.getAllByText("FEAT");
    expect(featBadges.length).toBeGreaterThanOrEqual(1);
    const fixBadges = screen.getAllByText("FIX");
    expect(fixBadges.length).toBeGreaterThanOrEqual(1);
  });

  it("shows blocked indicator for blocked tasks", async () => {
    mockFetchWith(MOCK_BACKLOG);
    renderWithProvider(<TasksDashboard />);
    await waitFor(() => {
      expect(screen.getByText("blocked")).toBeDefined();
    });
    expect(screen.getByText(/Blocked by:/)).toBeDefined();
  });

  it("shows empty state when no tasks", async () => {
    mockFetchWith({ items: [], pendingCount: 0, claimedCount: 0, manualDoneCount: 0 });
    renderWithProvider(<TasksDashboard />);
    await waitFor(() => {
      expect(screen.getByText("No pending or claimed tasks")).toBeDefined();
    });
  });

  it("fetches from correct API endpoint", async () => {
    const fetchMock = mockFetchWith(MOCK_BACKLOG);
    renderWithProvider(<TasksDashboard />);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/admin/tasks"))
      ).toBe(true);
    });
  });

  it("displays error when API returns error", async () => {
    mockFetchWith(null, "Backlog read failed");
    renderWithProvider(<TasksDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Backlog read failed")).toBeDefined();
    });
  });

  it("renders Create Task form with tag selector", async () => {
    mockFetchWith(MOCK_BACKLOG);
    renderWithProvider(<TasksDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Create Task")).toBeDefined();
    });
    // Default tags
    expect(screen.getAllByText("FEAT").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("FIX").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("DATA").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("INFRA").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("TEST").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("NMI").length).toBeGreaterThanOrEqual(1);
  });

  it("supports custom taskTags prop", async () => {
    mockFetchWith(MOCK_BACKLOG);
    renderWithProvider(<TasksDashboard taskTags={["CUSTOM", "OTHER"]} />);
    await waitFor(() => {
      expect(screen.getByText("CUSTOM")).toBeDefined();
    });
    expect(screen.getByText("OTHER")).toBeDefined();
  });

  it("submits new task via POST", async () => {
    const fetchMock = mockFetchWith(MOCK_BACKLOG, null, { position: "top" });
    renderWithProvider(<TasksDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Create Task")).toBeDefined();
    });

    const titleInput = screen.getByPlaceholderText(
      "e.g. Add dark mode toggle to settings page"
    ) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "New task title" } });

    // Submit the form
    const submitButton = screen.getByRole("button", { name: "Add Task" });
    fireEvent.click(submitButton);

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(postCall).toBeDefined();
      expect(String(postCall?.[0])).toContain("/api/admin/tasks");
    });
  });

  it("shows success message after task submission", async () => {
    mockFetchWith(MOCK_BACKLOG, null, { position: "top" });
    renderWithProvider(<TasksDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Create Task")).toBeDefined();
    });

    const titleInput = screen.getByPlaceholderText(
      "e.g. Add dark mode toggle to settings page"
    ) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "New task" } });

    fireEvent.click(screen.getByRole("button", { name: "Add Task" }));

    await waitFor(() => {
      expect(screen.getByText("Task added to mission 'mission-alpha'")).toBeDefined();
    });
  });

  it("renders Refresh button", async () => {
    mockFetchWith(MOCK_BACKLOG);
    renderWithProvider(<TasksDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Refresh")).toBeDefined();
    });
  });
});
