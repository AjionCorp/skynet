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
  codexAuthFile?: string;
  workers: SkynetWorkerDef[];
  triggerableScripts: string[];
  taskTags: string[];
  scriptsDir?: string; // defaults to devDir + "/scripts"
  agentPrefix?: string; // for LaunchAgent labels
  maxWorkers?: number; // max dev-worker instances (default 4)
  maxFixers?: number; // max task-fixer instances (default 3)
  staleMinutes?: number; // stale heartbeat threshold in minutes (default 30)
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
  filesTouched: string;
}

export interface FailedTask {
  date: string;
  task: string;
  branch: string;
  error: string;
  attempts: string;
  status: string;
  outcomeReason: string;
  filesTouched: string;
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
    manualDoneCount: number;
  };
  completed: CompletedTask[];
  completedCount: number;
  averageTaskDuration: string | null;
  failed: FailedTask[];
  failedPendingCount: number;
  hasBlockers: boolean;
  blockerLines: string[];
  healthScore: number;
  selfCorrectionRate: number;
  selfCorrectionStats: SelfCorrectionStats;
  syncHealth: {
    lastRun: string | null;
    endpoints: SyncEndpoint[];
  };
  auth: AuthStatus;
  backlogLocked: boolean;
  git: GitStatus;
  postCommitGate: PostCommitGate;
  missionState: MissionState | null;
  missionProgress: MissionProgress[];
  missionAlignmentScore: number;
  nonAlignedTaskCount: number;
  goalCompletionPercentage: number;
  laggingGoals: MissionProgress[];
  pipelinePaused: boolean;
  workerStats: Record<string, WorkerPerformanceStats>;
  watchdogRunning: boolean;
  projectDriverRunning: boolean;
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
  codex: CodexAuthStatus;
  gemini: GeminiAuthStatus;
}

export interface GeminiAuthStatus {
  status: "ok" | "missing";
  source: "api_key" | "cli_oauth" | "adc" | "missing";
}

export interface CodexAuthStatus {
  status: "ok" | "missing" | "expired" | "invalid" | "api_key";
  expiresInMs: number | null;
  hasRefreshToken: boolean;
  source: "api_key" | "file" | "missing" | "invalid";
}

// ===== Monitoring Status (full, from monitoring-dashboard) =====

export type MonitoringStatus = PipelineStatus;

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
  manualDoneCount: number;
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

export type MissionState = "ACTIVE" | "PAUSED" | "COMPLETE" | (string & {});

export interface GoalProgress {
  goalIndex: number;
  goalText: string;
  checked: boolean;
  relatedTasksCompleted: number;
}

export interface MissionStatus {
  state: MissionState | null;
  purpose: string | null;
  goals: MissionCriterion[];
  successCriteria: MissionCriterion[];
  goalProgress: GoalProgress[];
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

// ===== Mission Progress Types =====

export interface MissionProgress {
  id: number;
  criterion: string;
  status: "met" | "partial" | "not-met";
  evidence: string;
}

// ===== LLM Configuration Types =====

export interface LlmConfig {
  provider: "claude" | "codex" | "gemini" | "auto";
  model?: string;
}

// ===== Multi-Mission Types =====

export interface MissionSummary {
  slug: string;
  name: string;
  isActive: boolean;
  assignedWorkers: string[];
  completionPercentage: number;
  llmConfig?: LlmConfig;
}

export interface MissionConfig {
  activeMission: string;
  assignments: Record<string, string | null>;
  llmConfigs?: Record<string, LlmConfig>;
}

// ===== Mission Creator Types =====

export interface MissionCreatorSuggestion {
  id: string;
  title: string;
  content: string;
  applied: boolean;
  children: MissionCreatorSuggestion[];
  loading: boolean;
}

export interface MissionCreatorResult {
  mission: string;
  suggestions: Array<{
    title: string;
    content: string;
  }>;
}

// ===== Worker Performance Stats =====

export interface WorkerPerformanceStats {
  completedCount: number;
  failedCount: number;
  avgDuration: string | null;
  successRate: number;
}

// ===== Self-Correction Stats =====

export interface SelfCorrectionStats {
  fixed: number;
  blocked: number;
  superseded: number;
  pending: number;
  selfCorrected: number;
}

// ===== Project Driver Types =====

export interface ProjectDriverTelemetry {
  pendingBacklog: number;
  claimedBacklog: number;
  pendingRetries: number;
  fixRate: number;
  duplicateSkipped: number;
  maxNewTasks: number;
  driver_low_fix_rate_mode: boolean;
  ts: string;
}

export interface ProjectDriverStatus {
  running: boolean;
  pid: number | null;
  ageMs: number | null;
  lastLog: string | null;
  lastLogTime: string | null;
  telemetry: ProjectDriverTelemetry | null;
}

// ===== Task Velocity Types =====

export interface VelocityDataPoint {
  date: string;
  count: number;
  avgDurationMins: number | null;
}

// ===== Event Types =====

export interface EventEntry {
  ts: string;
  event: string;
  worker?: number;
  detail: string;
}

// ===== Mission Tracking Types =====

export interface MissionTracking {
  slug: string;
  name: string;
  assignedWorkers: number;
  activeWorkers: number;
  idleWorkers: number;
  backlogCount: number;
  inProgressCount: number;
  completedCount: number;
  completedLast24h: number;
  failedPendingCount: number;
  criteriaTotal: number;
  criteriaMet: number;
  completionPercentage: number;
  trackingStatus: "on-track" | "stalled" | "idle" | "no-workers" | "no-mission";
  trackingMessage: string;
}

// ===== Failure Analysis Types =====

export interface ErrorPattern {
  pattern: string;
  count: number;
  tasks: string[];
}

export interface FailureTimelinePoint {
  date: string;
  failures: number;
  fixed: number;
  blocked: number;
  superseded: number;
}

export interface WorkerFailureStats {
  workerId: number;
  failures: number;
  fixed: number;
  avgAttempts: number;
}

export interface FailureAnalysis {
  summary: SelfCorrectionStats & { total: number };
  errorPatterns: ErrorPattern[];
  timeline: FailureTimelinePoint[];
  byWorker: WorkerFailureStats[];
  recentFailures: FailedTask[];
}

// ===== Worker Intent Types =====

export interface WorkerIntent {
  workerId: number;
  workerType: string;
  status: string;
  taskId: number | null;
  taskTitle: string | null;
  branch: string | null;
  startedAt: string | null;
  lastHeartbeat: number | null;
  heartbeatAgeMs: number | null;
  lastProgress: number | null;
  progressAgeMs: number | null;
  lastInfo: string | null;
  updatedAt: string;
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

// ===== Goal Burndown Types =====

export interface GoalBurndownPoint {
  date: string;
  completed: number; // cumulative completed tasks for this goal
}

export interface GoalBurndownEntry {
  goalIndex: number;
  goalText: string;
  checked: boolean;
  relatedCompleted: number;
  relatedRemaining: number;
  burndown: GoalBurndownPoint[];
  velocityPerDay: number | null; // avg tasks/day over last 7 days
  etaDate: string | null; // projected completion date (YYYY-MM-DD)
  etaDays: number | null; // days until projected completion
}

// ===== Pipeline Explain Types =====

export interface PipelineExplainState {
  state: MissionState | null;
  completionPct: number;
  lagGoals: string[];
  topBlockers: string[];
  activeFailures: Record<string, number>;
  velocity24h: number;
  summary: string;
}
