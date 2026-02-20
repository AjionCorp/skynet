// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { PromptsDashboard } from "./PromptsDashboard";
import { SkynetProvider } from "./SkynetProvider";
import type { PromptTemplate } from "../types";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_PROMPTS: PromptTemplate[] = [
  {
    scriptName: "dev-worker",
    workerLabel: "Dev Worker",
    description: "Main development worker",
    category: "core",
    prompt: "You are a development worker.\nImplement the task:\n${TASK_DESCRIPTION}\nBranch: $BRANCH_NAME",
  },
  {
    scriptName: "task-fixer",
    workerLabel: "Task Fixer",
    description: "Fixes failed tasks",
    category: "testing",
    prompt: "Fix the following failed task:\n${TASK_TITLE}\nError: ${ERROR_MESSAGE}",
  },
  {
    scriptName: "sync-runner",
    workerLabel: "Sync Runner",
    description: "Runs data sync",
    category: "data",
    prompt: "Sync data for endpoint $ENDPOINT_NAME",
  },
];

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockFetchWith(data: PromptTemplate[] | null, error: string | null = null) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data, error }))
  ));
}

describe("PromptsDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderWithProvider(<PromptsDashboard />);
    expect(screen.getByText("Loading prompt templates...")).toBeDefined();
  });

  it("renders prompt template list from mock fetch", async () => {
    mockFetchWith(MOCK_PROMPTS);
    renderWithProvider(<PromptsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Dev Worker")).toBeDefined();
    });
    expect(screen.getByText("Task Fixer")).toBeDefined();
    expect(screen.getByText("Sync Runner")).toBeDefined();
  });

  it("displays prompt count in header", async () => {
    mockFetchWith(MOCK_PROMPTS);
    renderWithProvider(<PromptsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Prompt Templates")).toBeDefined();
    });
    expect(screen.getByText("3 worker prompts")).toBeDefined();
  });

  it("renders category badges for each prompt", async () => {
    mockFetchWith(MOCK_PROMPTS);
    renderWithProvider(<PromptsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("core")).toBeDefined();
    });
    expect(screen.getByText("testing")).toBeDefined();
    expect(screen.getByText("data")).toBeDefined();
  });

  it("shows script name and description", async () => {
    mockFetchWith(MOCK_PROMPTS);
    renderWithProvider(<PromptsDashboard />);
    await waitFor(() => {
      expect(screen.getByText(/dev-worker\.sh/)).toBeDefined();
    });
    expect(screen.getByText(/Main development worker/)).toBeDefined();
  });

  it("shows line count for each prompt", async () => {
    mockFetchWith(MOCK_PROMPTS);
    renderWithProvider(<PromptsDashboard />);
    await waitFor(() => {
      // "dev-worker" prompt has 3 lines
      expect(screen.getByText("3 lines")).toBeDefined();
    });
  });

  it("expands prompt to show code block formatting with variable highlighting", async () => {
    mockFetchWith(MOCK_PROMPTS);
    renderWithProvider(<PromptsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Dev Worker")).toBeDefined();
    });

    // Click to expand the first prompt
    fireEvent.click(screen.getByText("Dev Worker"));

    await waitFor(() => {
      // The prompt text should be visible in a <pre> block
      expect(screen.getByText(/You are a development worker/)).toBeDefined();
    });
    // Variables like ${TASK_DESCRIPTION} should be rendered
    expect(screen.getByText("${TASK_DESCRIPTION}")).toBeDefined();
    expect(screen.getByText("$BRANCH_NAME")).toBeDefined();
  });

  it("shows empty state when no prompts", async () => {
    mockFetchWith([]);
    renderWithProvider(<PromptsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Prompt Templates")).toBeDefined();
    });
    expect(screen.getByText("0 worker prompts")).toBeDefined();
  });

  it("displays error when API returns error", async () => {
    mockFetchWith(null, "Failed to read prompts");
    renderWithProvider(<PromptsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Failed to read prompts")).toBeDefined();
    });
  });

  it("fetches from correct API endpoint", async () => {
    mockFetchWith(MOCK_PROMPTS);
    renderWithProvider(<PromptsDashboard />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/prompts");
    });
  });

  it("renders Expand All and Collapse All buttons", async () => {
    mockFetchWith(MOCK_PROMPTS);
    renderWithProvider(<PromptsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Expand All")).toBeDefined();
    });
    expect(screen.getByText("Collapse All")).toBeDefined();
  });

  it("supports scripts filter prop", async () => {
    mockFetchWith(MOCK_PROMPTS);
    renderWithProvider(<PromptsDashboard scripts={["dev-worker"]} />);
    await waitFor(() => {
      expect(screen.getByText("Dev Worker")).toBeDefined();
    });
    expect(screen.getByText("1 worker prompt")).toBeDefined();
    // Other prompts should be filtered out
    expect(screen.queryByText("Task Fixer")).toBeNull();
  });
});
