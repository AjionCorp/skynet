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
  maxWorkers?: number; // max dev-worker instances (default 4)
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
  blockedBy: string[];
  blocked: boolean;
}

export interface CompletedTask {
  date: string;
  task: string;
  branch: string;
  duration: string;
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

// ===== Worker Heartbeat =====

export interface WorkerHeartbeat {
  /** Epoch timestamp of the last heartbeat, or null if no heartbeat file */
  lastEpoch: number | null;
  /** Age of the heartbeat in milliseconds, or null if no heartbeat */
  ageMs: number | null;
  /** True if the heartbeat is older than the stale threshold */
  isStale: boolean;
}

// ===== Pipeline Status (matches pipeline-status handler response) =====

export interface PipelineStatus {
  workers: WorkerInfo[];
  currentTask: CurrentTask;
  currentTasks: Record<string, CurrentTask>;
  heartbeats: Record<string, WorkerHeartbeat>;
  backlog: {
    items: BacklogItem[];
    pendingCount: number;
    claimedCount: number;
    doneCount: number;
  };
  completed: CompletedTask[];
  completedCount: number;
  averageTaskDuration: string | null;
  failed: FailedTask[];
  failedPendingCount: number;
  hasBlockers: boolean;
  blockerLines: string[];
  healthScore: number;
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
  currentTasks: Record<string, CurrentTask>;
  heartbeats: Record<string, WorkerHeartbeat>;
  backlog: {
    items: BacklogItem[];
    pendingCount: number;
    claimedCount: number;
    doneCount: number;
  };
  completed: CompletedTask[];
  completedCount: number;
  averageTaskDuration: string | null;
  failed: FailedTask[];
  failedPendingCount: number;
  hasBlockers: boolean;
  blockerLines: string[];
  healthScore: number;
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
  blockedBy?: string;
}

// ===== Sync Status =====

export interface SyncStatus {
  api_name: string;
  status: "success" | "syncing" | "error" | "pending";
  last_synced: string | null;
  records_count: number | null;
  error_message: string | null;
}

// ===== Mission Types =====

export interface MissionCriterion {
  text: string;
  completed: boolean;
}

export interface MissionStatus {
  purpose: string | null;
  goals: MissionCriterion[];
  successCriteria: MissionCriterion[];
  currentFocus: string | null;
  completionPercentage: number;
  raw: string;
}

// ===== Prompt Types =====

export interface PromptTemplate {
  scriptName: string;
  workerLabel: string;
  description: string;
  category: "core" | "testing" | "infra" | "data";
  prompt: string;
}

// ===== Worker Scaling Types =====

export interface WorkerScalePayload {
  workerType: string;
  count: number;
}

export interface WorkerScaleInfo {
  type: string;
  label: string;
  count: number;
  maxCount: number;
  pids: number[];
}

export interface WorkerScaleResult {
  workerType: string;
  previousCount: number;
  currentCount: number;
  maxCount: number;
}
