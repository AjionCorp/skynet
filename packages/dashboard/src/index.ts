// Types
export type {
  SkynetConfig,
  SkynetWorkerDef,
  WorkerInfo,
  WorkerHeartbeat,
  CurrentTask,
  BacklogItem,
  CompletedTask,
  FailedTask,
  SyncEndpoint,
  PipelineStatus,
  GitStatus,
  PostCommitGate,
  AuthStatus,
  MonitoringStatus,
  AgentInfo,
  LogData,
  TaskBacklogData,
  TaskCreatePayload,
  SyncStatus,
  WorkerScalePayload,
  WorkerScaleInfo,
  WorkerScaleResult,
} from "./types";

// Config helpers
export { createConfig, DEFAULT_WORKERS } from "./lib/config";

// Utilities
export { readDevFile, getLastLogLine, extractTimestamp } from "./lib/file-reader";
export { getWorkerStatus } from "./lib/worker-status";
export { parseBacklog, backlogCounts } from "./lib/backlog-parser";
export type { ParsedBacklogItem } from "./lib/backlog-parser";

// Handler factories
export {
  createPipelineStatusHandler,
  createPipelineStreamHandler,
  createPipelineTriggerHandler,
  createPipelineLogsHandler,
  createMonitoringStatusHandler,
  createMonitoringAgentsHandler,
  createMonitoringLogsHandler,
  createTasksHandlers,
  createWorkerScalingHandler,
} from "./handlers";

// Dashboard UI components
export * from "./components/index";
