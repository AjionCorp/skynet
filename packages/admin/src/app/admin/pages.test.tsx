// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock dashboard components from @ajioncorp/skynet/components.
// Each mock can be swapped to a throwing version per-test to verify
// ErrorBoundary integration.
// ---------------------------------------------------------------------------
let mockThrow: string | null = null;

function maybeFail(name: string) {
  if (mockThrow === name) throw new Error(`${name} render failed`);
}

vi.mock("@ajioncorp/skynet/components", () => ({
  PipelineDashboard: () => { maybeFail("PipelineDashboard"); return <div data-testid="PipelineDashboard">Pipeline</div>; },
  EventsDashboard: () => { maybeFail("EventsDashboard"); return <div data-testid="EventsDashboard">Events</div>; },
  LogViewer: () => { maybeFail("LogViewer"); return <div data-testid="LogViewer">Logs</div>; },
  TasksDashboard: () => { maybeFail("TasksDashboard"); return <div data-testid="TasksDashboard">Tasks</div>; },
  MonitoringDashboard: () => { maybeFail("MonitoringDashboard"); return <div data-testid="MonitoringDashboard">Monitoring</div>; },
  WorkerScaling: () => { maybeFail("WorkerScaling"); return <div data-testid="WorkerScaling">Workers</div>; },
  MissionDashboard: () => { maybeFail("MissionDashboard"); return <div data-testid="MissionDashboard">Mission</div>; },
  SettingsDashboard: () => { maybeFail("SettingsDashboard"); return <div data-testid="SettingsDashboard">Settings</div>; },
  ProjectDriverDashboard: () => { maybeFail("ProjectDriverDashboard"); return <div data-testid="ProjectDriverDashboard">ProjectDriver</div>; },
  PromptsDashboard: () => { maybeFail("PromptsDashboard"); return <div data-testid="PromptsDashboard">Prompts</div>; },
  SyncDashboard: () => { maybeFail("SyncDashboard"); return <div data-testid="SyncDashboard">Sync</div>; },
}));

// Mock lucide-react used by ErrorBoundary and LoadingSkeleton
vi.mock("lucide-react", () => ({
  AlertTriangle: () => <span>AlertTriangle</span>,
  RefreshCw: () => <span>RefreshCw</span>,
  Loader2: () => <span>Loader2</span>,
}));

// ---------------------------------------------------------------------------
// Page imports (after mocks)
// ---------------------------------------------------------------------------
import PipelinePage from "./pipeline/page";
import EventsPage from "./events/page";
import LogsPage from "./logs/page";
import TasksPage from "./tasks/page";
import MonitoringPage from "./monitoring/page";
import WorkersPage from "./workers/page";
import MissionPage from "./mission/page";
import SettingsPage from "./settings/page";
import ProjectDriverPage from "./project-driver/page";
import PromptsPage from "./prompts/page";
import SyncPage from "./sync/page";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
const pages = [
  { name: "PipelinePage", Component: PipelinePage, testId: "PipelineDashboard" },
  { name: "EventsPage", Component: EventsPage, testId: "EventsDashboard" },
  { name: "LogsPage", Component: LogsPage, testId: "LogViewer" },
  { name: "TasksPage", Component: TasksPage, testId: "TasksDashboard" },
  { name: "MonitoringPage", Component: MonitoringPage, testId: "MonitoringDashboard" },
  { name: "WorkersPage", Component: WorkersPage, testId: "WorkerScaling" },
  { name: "MissionPage", Component: MissionPage, testId: "MissionDashboard" },
  { name: "SettingsPage", Component: SettingsPage, testId: "SettingsDashboard" },
  { name: "ProjectDriverPage", Component: ProjectDriverPage, testId: "ProjectDriverDashboard" },
  { name: "PromptsPage", Component: PromptsPage, testId: "PromptsDashboard" },
  { name: "SyncPage", Component: SyncPage, testId: "SyncDashboard" },
] as const;

// Secondary pages = everything except PipelinePage (the primary dashboard)
const secondaryPages = pages.filter((p) => p.name !== "PipelinePage");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Admin page smoke tests", () => {
  beforeEach(() => {
    mockThrow = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  for (const { name, Component, testId } of pages) {
    describe(name, () => {
      it("renders without crashing", () => {
        const { container } = render(<Component />);
        expect(container.firstElementChild).not.toBeNull();
      });

      it("renders the dashboard component", () => {
        render(<Component />);
        expect(screen.getByTestId(testId)).toBeDefined();
      });
    });
  }
});

describe("Secondary page ErrorBoundary integration", () => {
  beforeEach(() => {
    mockThrow = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    mockThrow = null;
    cleanup();
    vi.restoreAllMocks();
  });

  for (const { name, Component, testId } of secondaryPages) {
    it(`${name} shows error UI when child component throws`, () => {
      mockThrow = testId;
      render(<Component />);
      expect(screen.getByText("Something went wrong")).toBeDefined();
      expect(screen.getByText(`${testId} render failed`)).toBeDefined();
      expect(screen.getByRole("button", { name: /retry/i })).toBeDefined();
    });
  }
});
