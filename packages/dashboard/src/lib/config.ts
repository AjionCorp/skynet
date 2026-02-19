import type { SkynetConfig, SkynetWorkerDef } from "../types";

export const DEFAULT_WORKERS: SkynetWorkerDef[] = [
  {
    name: "dev-worker-1",
    label: "Dev Worker 1",
    category: "core",
    schedule: "On demand",
    description: "Implements tasks via Claude Code",
    logFile: "dev-worker-1",
  },
  {
    name: "dev-worker-2",
    label: "Dev Worker 2",
    category: "core",
    schedule: "On demand",
    description: "Implements tasks via Claude Code",
    logFile: "dev-worker-2",
  },
  {
    name: "dev-worker-3",
    label: "Dev Worker 3",
    category: "core",
    schedule: "On demand",
    description: "Implements tasks via Claude Code",
    logFile: "dev-worker-3",
  },
  {
    name: "dev-worker-4",
    label: "Dev Worker 4",
    category: "core",
    schedule: "On demand",
    description: "Implements tasks via Claude Code",
    logFile: "dev-worker-4",
  },
  {
    name: "task-fixer",
    label: "Task Fixer 1",
    category: "core",
    schedule: "Every 30m",
    description: "Diagnoses and fixes failed tasks",
  },
  {
    name: "task-fixer-2",
    label: "Task Fixer 2",
    category: "core",
    schedule: "On demand",
    description: "Diagnoses and fixes failed tasks",
    logFile: "task-fixer-2",
  },
  {
    name: "task-fixer-3",
    label: "Task Fixer 3",
    category: "core",
    schedule: "On demand",
    description: "Diagnoses and fixes failed tasks",
    logFile: "task-fixer-3",
  },
  {
    name: "project-driver",
    label: "Project Driver",
    category: "core",
    schedule: "8am + 8pm",
    description: "Generates and prioritizes backlog",
  },
  {
    name: "sync-runner",
    label: "Sync Runner",
    category: "data",
    schedule: "Every 6h",
    description: "Syncs all data endpoints",
  },
  {
    name: "ui-tester",
    label: "UI Tester",
    category: "testing",
    schedule: "Every 1h",
    description: "Playwright smoke tests",
  },
  {
    name: "feature-validator",
    label: "Feature Validator",
    category: "testing",
    schedule: "Every 2h",
    description: "Deep page + API tests",
  },
  {
    name: "health-check",
    label: "Health Check",
    category: "infra",
    schedule: "Daily 8am",
    description: "Typecheck + lint",
  },
  {
    name: "auth-refresh",
    label: "Auth Refresh",
    category: "infra",
    schedule: "Every 30m",
    description: "OAuth token refresh",
  },
  {
    name: "watchdog",
    label: "Watchdog",
    category: "infra",
    schedule: "Every 3m",
    description: "Kicks off idle workers",
  },
];

export function createConfig(
  overrides: Partial<SkynetConfig> &
    Pick<SkynetConfig, "projectName" | "devDir" | "lockPrefix">
): SkynetConfig {
  return {
    workers: DEFAULT_WORKERS,
    triggerableScripts: [
      "dev-worker",
      "task-fixer",
      "project-driver",
      "sync-runner",
      "ui-tester",
      "feature-validator",
      "health-check",
    ],
    taskTags: ["FEAT", "FIX", "INFRA", "TEST", "NMI"],
    ...overrides,
  };
}
