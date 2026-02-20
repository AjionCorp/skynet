# @ajioncorp/skynet

Embeddable dashboard components and API handlers for Skynet pipeline monitoring.

## Installation

```bash
npm install @ajioncorp/skynet
```

**Peer dependencies:** `next >=14`, `react >=18`, `react-dom >=18`

## Quick Start

Wrap your app with `SkynetProvider` and mount a dashboard component:

```tsx
import { SkynetProvider } from "@ajioncorp/skynet/components";
import { PipelineDashboard } from "@ajioncorp/skynet/components";

export default function Page() {
  return (
    <SkynetProvider apiPrefix="/api/skynet">
      <PipelineDashboard />
    </SkynetProvider>
  );
}
```

Create API route handlers in your Next.js app (e.g. `app/api/skynet/pipeline/route.ts`):

```ts
import { createPipelineStatusHandler } from "@ajioncorp/skynet/handlers";

const config = {
  projectName: "my-project",
  devDir: "/path/to/project/.dev",
  lockPrefix: "/tmp/skynet-my-project",
  workers: [],
};

export const GET = createPipelineStatusHandler(config);
```

## Handler Factories

Each factory takes a `SkynetConfig` and returns a Next.js route handler.

| Factory | Method | Description |
|---|---|---|
| `createPipelineStatusHandler` | GET | Full pipeline status (workers, tasks, health) |
| `createPipelineStreamHandler` | GET | SSE stream of pipeline status changes |
| `createPipelineTriggerHandler` | POST | Trigger a script with PID lock protection |
| `createPipelineLogsHandler` | GET | Tail log files with optional search |
| `createMonitoringStatusHandler` | GET | Monitoring-scoped pipeline status |
| `createMonitoringAgentsHandler` | GET | LaunchAgent status via plist inspection |
| `createMonitoringLogsHandler` | GET | Monitoring-scoped log viewer |
| `createTasksHandlers` | GET/POST | Backlog task read and create |
| `createPromptsHandler` | GET | Worker prompt templates |
| `createWorkerScalingHandler` | GET/POST | Scale worker counts |
| `createMissionStatusHandler` | GET | Parsed mission criteria and progress |
| `createMissionRawHandler` | GET | Raw mission.md contents |
| `createConfigHandler` | GET/POST | Read/write skynet.config.sh values |
| `createEventsHandler` | GET | Parsed events log entries |

## Components

All components are React client components. Use inside a `<SkynetProvider>`.

| Component | Description |
|---|---|
| `SkynetProvider` | Context provider — sets `apiPrefix` for all children |
| `PipelineDashboard` | Full pipeline status with SSE streaming |
| `TasksDashboard` | Backlog task management |
| `MonitoringDashboard` | System monitoring (agents, logs, health) |
| `MissionDashboard` | Mission criteria and progress |
| `PromptsDashboard` | Worker prompt template browser |
| `SettingsDashboard` | Config key-value editor |
| `EventsDashboard` | Events log viewer |
| `WorkerScaling` | Worker count scaling controls |
| `LogViewer` | Log file viewer with search |
| `ActivityFeed` | Activity event feed |
| `AdminLayout` | Page shell with nav header and sidebar |

## TypeScript

All types are exported from the package root:

```ts
import type { SkynetConfig, PipelineStatus, BacklogItem } from "@ajioncorp/skynet";
```

See [`src/types.ts`](./src/types.ts) for the full type reference.
