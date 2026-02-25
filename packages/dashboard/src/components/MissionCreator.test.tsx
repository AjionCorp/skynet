// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { MissionCreator } from "./MissionCreator";
import { SkynetProvider } from "./SkynetProvider";

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

const MOCK_GENERATE_RESPONSE = {
  data: {
    mission: "# Mission\n\n## Purpose\nBuild a CI/CD pipeline\n\n## Goals\n- [ ] Deploy automatically\n\n## Success Criteria\n- [ ] Zero downtime\n\n## Current Focus\nSetup",
    suggestions: [
      { title: "Add Monitoring", content: "Implement real-time monitoring with alerts" },
      { title: "Add Testing", content: "Set up comprehensive test suites" },
      { title: "Add Rollback", content: "Implement automated rollback mechanisms" },
    ],
  },
  error: null,
};

const MOCK_EXPAND_RESPONSE = {
  data: {
    suggestions: [
      { title: "Sub 1", content: "Sub detail 1" },
      { title: "Sub 2", content: "Sub detail 2" },
      { title: "Sub 3", content: "Sub detail 3" },
    ],
  },
  error: null,
};

function mockFetch() {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/mission/creator/expand")) {
      return Promise.resolve(new Response(JSON.stringify(MOCK_EXPAND_RESPONSE)));
    }
    if (url.includes("/mission/creator")) {
      return Promise.resolve(new Response(JSON.stringify(MOCK_GENERATE_RESPONSE)));
    }
    return Promise.resolve(new Response(JSON.stringify({ data: null, error: null })));
  }));
}

describe("MissionCreator", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders input textarea and generate button", () => {
    mockFetch();
    const onApply = vi.fn();
    const onClose = vi.fn();
    renderWithProvider(<MissionCreator currentMission="" onApply={onApply} onClose={onClose} />);
    expect(screen.getByText("AI Mission Creator")).toBeDefined();
    expect(screen.getByText("Describe Your Mission")).toBeDefined();
    expect(screen.getByText("Generate with AI")).toBeDefined();
  });

  it("disables generate button when input is empty", () => {
    mockFetch();
    renderWithProvider(<MissionCreator currentMission="" onApply={vi.fn()} onClose={vi.fn()} />);
    const btn = screen.getByText("Generate with AI").closest("button")!;
    expect(btn.disabled).toBe(true);
  });

  it("calls onClose when Close button is clicked", () => {
    mockFetch();
    const onClose = vi.fn();
    renderWithProvider(<MissionCreator currentMission="" onApply={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders generated mission and suggestions after generate", async () => {
    mockFetch();
    renderWithProvider(<MissionCreator currentMission="" onApply={vi.fn()} onClose={vi.fn()} />);

    // Type input
    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Build a CI/CD pipeline" } });

    // Click generate
    fireEvent.click(screen.getByText("Generate with AI"));

    await waitFor(() => {
      expect(screen.getByText("Generated Mission")).toBeDefined();
    });

    // Check mission content rendered in pre block
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("Build a CI/CD pipeline");

    // Check suggestions
    expect(screen.getByText("Add Monitoring")).toBeDefined();
    expect(screen.getByText("Add Testing")).toBeDefined();
    expect(screen.getByText("Add Rollback")).toBeDefined();
  });

  it("renders Apply to Mission button after generation", async () => {
    mockFetch();
    renderWithProvider(<MissionCreator currentMission="" onApply={vi.fn()} onClose={vi.fn()} />);

    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Build something" } });
    fireEvent.click(screen.getByText("Generate with AI"));

    await waitFor(() => {
      expect(screen.getByText("Apply to Mission")).toBeDefined();
    });
  });

  it("calls onApply when Apply to Mission is clicked", async () => {
    mockFetch();
    const onApply = vi.fn();
    renderWithProvider(<MissionCreator currentMission="" onApply={onApply} onClose={vi.fn()} />);

    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Build something" } });
    fireEvent.click(screen.getByText("Generate with AI"));

    await waitFor(() => {
      expect(screen.getByText("Apply to Mission")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Apply to Mission"));
    expect(onApply).toHaveBeenCalledWith(MOCK_GENERATE_RESPONSE.data.mission);
  });

  it("shows Apply and Expand buttons on suggestion nodes", async () => {
    mockFetch();
    renderWithProvider(<MissionCreator currentMission="" onApply={vi.fn()} onClose={vi.fn()} />);

    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Build something" } });
    fireEvent.click(screen.getByText("Generate with AI"));

    await waitFor(() => {
      expect(screen.getByText("Add Monitoring")).toBeDefined();
    });

    // Each suggestion should have Apply and Expand buttons
    const applyButtons = screen.getAllByText("Apply");
    const expandButtons = screen.getAllByText("Expand");
    expect(applyButtons.length).toBe(3);
    expect(expandButtons.length).toBe(3);
  });

  it("shows error when API returns error", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ data: null, error: "AI generation failed" }))),
    ));

    renderWithProvider(<MissionCreator currentMission="" onApply={vi.fn()} onClose={vi.fn()} />);

    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Build something" } });
    fireEvent.click(screen.getByText("Generate with AI"));

    await waitFor(() => {
      expect(screen.getByText("AI generation failed")).toBeDefined();
    });
  });

  it("renders Improvement Suggestions header after generation", async () => {
    mockFetch();
    renderWithProvider(<MissionCreator currentMission="" onApply={vi.fn()} onClose={vi.fn()} />);

    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "Build something" } });
    fireEvent.click(screen.getByText("Generate with AI"));

    await waitFor(() => {
      expect(screen.getByText("Improvement Suggestions")).toBeDefined();
    });
  });
});
