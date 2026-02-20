// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { SettingsDashboard } from "./SettingsDashboard";
import { SkynetProvider } from "./SkynetProvider";

interface ConfigEntry {
  key: string;
  value: string;
  comment: string;
}

const MOCK_ENTRIES: ConfigEntry[] = [
  { key: "MAX_WORKERS", value: "4", comment: "Worker Settings" },
  { key: "POLL_INTERVAL", value: "30", comment: "Worker Settings" },
  { key: "AUTO_MERGE", value: "true", comment: "Pipeline" },
  { key: "LOG_LEVEL", value: "debug", comment: "General" },
];

function renderWithProvider(ui: React.ReactElement) {
  return render(<SkynetProvider apiPrefix="/api/admin">{ui}</SkynetProvider>);
}

function mockConfigGet(entries: ConfigEntry[], configPath = "/path/to/skynet.config.sh") {
  global.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: { entries, configPath }, error: null }))
  );
}

describe("SettingsDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders config key-value rows from mock API response", async () => {
    mockConfigGet(MOCK_ENTRIES);
    renderWithProvider(<SettingsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("MAX_WORKERS")).toBeDefined();
    });
    expect(screen.getByText("POLL_INTERVAL")).toBeDefined();
    expect(screen.getByText("AUTO_MERGE")).toBeDefined();
    expect(screen.getByText("LOG_LEVEL")).toBeDefined();
  });

  it("displays section headings grouped by comment", async () => {
    mockConfigGet(MOCK_ENTRIES);
    renderWithProvider(<SettingsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Worker Settings")).toBeDefined();
    });
    expect(screen.getByText("Pipeline")).toBeDefined();
    expect(screen.getByText("General")).toBeDefined();
  });

  it("renders boolean values as select dropdowns", async () => {
    mockConfigGet(MOCK_ENTRIES);
    renderWithProvider(<SettingsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("AUTO_MERGE")).toBeDefined();
    });
    // AUTO_MERGE is "true" — should be a <select>
    const selects = document.querySelectorAll("select");
    expect(selects.length).toBe(1);
    expect((selects[0] as HTMLSelectElement).value).toBe("true");
  });

  it("shows configPath in header", async () => {
    mockConfigGet(MOCK_ENTRIES, "/custom/path/config.sh");
    renderWithProvider(<SettingsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("/custom/path/config.sh")).toBeDefined();
    });
  });

  it("save button sends POST with updated values", async () => {
    const updatedEntries = MOCK_ENTRIES.map((e) =>
      e.key === "MAX_WORKERS" ? { ...e, value: "8" } : e
    );

    global.fetch = vi.fn()
      // Initial GET
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { entries: MOCK_ENTRIES, configPath: "" }, error: null }))
      )
      // POST save
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { entries: updatedEntries }, error: null }))
      );

    renderWithProvider(<SettingsDashboard />);

    await waitFor(() => {
      expect(screen.getByText("MAX_WORKERS")).toBeDefined();
    });

    // Find the input for MAX_WORKERS and change it
    const inputs = document.querySelectorAll<HTMLInputElement>("input[type='text']");
    const maxWorkersInput = Array.from(inputs).find((i) => i.value === "4");
    expect(maxWorkersInput).toBeDefined();
    fireEvent.change(maxWorkersInput!, { target: { value: "8" } });

    // Verify dirty state shown
    await waitFor(() => {
      expect(screen.getByText("1 unsaved change")).toBeDefined();
    });

    // Click save
    fireEvent.click(screen.getByText("Save Changes"));

    await waitFor(() => {
      expect(screen.getByText("Configuration saved successfully")).toBeDefined();
    });

    // Verify POST was called with correct body
    const postCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[1] === "object" && (c[1] as RequestInit).method === "POST"
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.updates).toEqual({ MAX_WORKERS: "8" });
  });

  it("displays validation error on invalid input (API error)", async () => {
    global.fetch = vi.fn()
      // Initial GET
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { entries: MOCK_ENTRIES, configPath: "" }, error: null }))
      )
      // POST returns validation error
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: null, error: "Invalid value for MAX_WORKERS: must be a number" }))
      );

    renderWithProvider(<SettingsDashboard />);

    await waitFor(() => {
      expect(screen.getByText("MAX_WORKERS")).toBeDefined();
    });

    // Change a value
    const inputs = document.querySelectorAll<HTMLInputElement>("input[type='text']");
    const maxWorkersInput = Array.from(inputs).find((i) => i.value === "4");
    fireEvent.change(maxWorkersInput!, { target: { value: "not-a-number" } });

    // Click save
    fireEvent.click(screen.getByText("Save Changes"));

    await waitFor(() => {
      expect(screen.getByText("Invalid value for MAX_WORKERS: must be a number")).toBeDefined();
    });
  });

  it("shows loading state initially", () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    renderWithProvider(<SettingsDashboard />);
    expect(screen.getByText("Loading configuration...")).toBeDefined();
  });

  it("shows empty state when no entries returned", async () => {
    mockConfigGet([]);
    renderWithProvider(<SettingsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("No configuration found")).toBeDefined();
    });
  });

  it("displays error when API returns error", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: null, error: "Config file not found" }))
    );
    renderWithProvider(<SettingsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Config file not found")).toBeDefined();
    });
  });

  it("displays error when fetch throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
    renderWithProvider(<SettingsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeDefined();
    });
  });

  it("shows 'No changes' when nothing is edited", async () => {
    mockConfigGet(MOCK_ENTRIES);
    renderWithProvider(<SettingsDashboard />);
    await waitFor(() => {
      expect(screen.getByText("No changes")).toBeDefined();
    });
  });

  it("fetches from correct API endpoint", async () => {
    mockConfigGet([]);
    renderWithProvider(<SettingsDashboard />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/admin/config");
    });
  });
});
