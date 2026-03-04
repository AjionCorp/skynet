// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Mock all dashboard components from @ajioncorp/skynet/components
vi.mock("@ajioncorp/skynet/components", () => ({
  PipelineDashboard: () => <div data-testid="PipelineDashboard">Pipeline</div>,
  EventsDashboard: () => <div data-testid="EventsDashboard">Events</div>,
  LogViewer: () => <div data-testid="LogViewer">Logs</div>,
  TasksDashboard: () => <div data-testid="TasksDashboard">Tasks</div>,
  MonitoringDashboard: () => (
    <div data-testid="MonitoringDashboard">Monitoring</div>
  ),
  WorkerScaling: () => <div data-testid="WorkerScaling">Workers</div>,
  MissionDashboard: () => <div data-testid="MissionDashboard">Mission</div>,
  SettingsDashboard: () => <div data-testid="SettingsDashboard">Settings</div>,
  ProjectDriverDashboard: () => (
    <div data-testid="ProjectDriverDashboard">ProjectDriver</div>
  ),
  PromptsDashboard: () => <div data-testid="PromptsDashboard">Prompts</div>,
  SyncDashboard: () => <div data-testid="SyncDashboard">Sync</div>,
}));

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

describe("Admin page smoke tests", () => {
  afterEach(() => {
    cleanup();
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
