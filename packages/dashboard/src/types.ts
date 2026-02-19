// ===== Configuration Types =====

export interface SkynetWorkerDef {
  name: string;
  label: string;
  category?: "core" | "testing" | "infra" | "data";
  schedule: string;
  description: string;
  logFile?: string; // defaults to name
}

export interface SkynetConfig {
  projectName: string;
  devDir: string;
  lockPrefix: string;
  authTokenCache?: string;
  authFailFlag?: string;
  workers: SkynetWorkerDef[];
  triggerableScripts: string[];
  taskTags: string[];
  scriptsDir?: string; // defaults to devDir + "/scripts"
  agentPrefix?: string; // for LaunchAgent labels
}

// ===== Worker / Pipeline Types =====

export interface WorkerInfo {
  name: string;
  label: string;
  category: "core" | "testing" | "infra" | "data";
  schedule: string;
  description: string;
  running: boolean;
  pid: number | null;
  ageMs: number | null;
  lastLog: string | null;
  lastLogTime: string | null;
  logFile: string;
}

export interface CurrentTask {
  status: string;
  title: string | null;
  branch: string | null;
  started: string | null;
  worker: string | null;
  lastInfo: string | null;
}

export interface BacklogItem {
  text: string;
  tag: string;
  status: "pending" | "claimed" | "done";
}

export interface CompletedTask {
  date: string;
  task: string;
  branch: string;
  notes: string;
}

export interface FailedTask {
  date: string;
  task: string;
  branch: string;
  error: string;
  attempts: string;
  status: string;
}

export interface SyncEndpoint {
  endpoint: string;
  lastRun: string;
  status: string;
  records: string;
  notes: string;
}

// ===== Pipeline Status (simpler, from pipeline-dashboard) =====

export interface PipelineStatus {
  workers: WorkerInfo[];
  currentTask: CurrentTask;
  backlog: string[];
  backlogCount: number;
  completedCount: number;
  recentCompleted: CompletedTask[];
  failedPending: FailedTask[];
  hasBlockers: boolean;
  blockerLines: string[];
  syncHealth: SyncEndpoint[];
  lastSyncRun: string | null;
  timestamp: string;
}

// ===== Git / System Types =====

export interface GitStatus {
  branch: string;
  commitsAhead: number;
  dirtyFiles: number;
  lastCommit: string | null;
}

export interface PostCommitGate {
  lastResult: string | null;
  lastCommit: string | null;
  lastTime: string | null;
}

export interface AuthStatus {
  tokenCached: boolean;
  tokenCacheAgeMs: number | null;
  authFailFlag: boolean;
  lastFailEpoch: number | null;
}

// ===== Monitoring Status (full, from monitoring-dashboard) =====

export interface MonitoringStatus {
  workers: WorkerInfo[];
  currentTask: CurrentTask;
  backlog: {
    items: BacklogItem[];
    pendingCount: number;
    claimedCount: number;
    doneCount: number;
  };
  completed: CompletedTask[];
  completedCount: number;
  failed: FailedTask[];
  failedPendingCount: number;
  hasBlockers: boolean;
  blockerLines: string[];
  syncHealth: {
    lastRun: string | null;
    endpoints: SyncEndpoint[];
  };
  auth: AuthStatus;
  backlogLocked: boolean;
  git: GitStatus;
  postCommitGate: PostCommitGate;
  timestamp: string;
}

// ===== Agent Types =====

export interface AgentInfo {
  label: string;
  name: string;
  loaded: boolean;
  lastExitStatus: number | null;
  pid: string | null;
  plistExists: boolean;
  interval: number | null;
  intervalHuman: string | null;
  runAtLoad: boolean;
  scriptPath: string | null;
  logPath: string | null;
}

// ===== Log Types =====

export interface LogData {
  script: string;
  lines: string[];
  totalLines: number;
  fileSizeBytes: number;
  count: number;
}

// ===== Task Types =====

export interface TaskBacklogData {
  items: BacklogItem[];
  pendingCount: number;
  claimedCount: number;
  doneCount: number;
}

export interface TaskCreatePayload {
  tag: string;
  title: string;
  description?: string;
  position?: "top" | "bottom";
}

// ===== Sync Status (replaces @basedgov/types SyncStatus) =====

export interface SyncStatus {
  api_name: string;
  status: "success" | "syncing" | "error" | "pending";
  last_synced: string | null;
  records_count: number | null;
  error_message: string | null;
}
