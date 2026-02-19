"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  GitBranch,
  Key,
  LayoutDashboard,
  ListTodo,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  Terminal,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  WorkerInfo,
  MonitoringStatus,
  AgentInfo,
  LogData,
} from "../types";
import { useSkynet } from "./SkynetProvider";

// ===== Constants =====

const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "workers", label: "Workers", icon: Cpu },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "logs", label: "Logs", icon: Terminal },
  { id: "system", label: "System", icon: Settings },
] as const;

type TabId = (typeof TABS)[number]["id"];

const TASK_TABS = ["backlog", "completed", "failed", "blockers"] as const;
type TaskTabId = (typeof TASK_TABS)[number];

const CATEGORY_LABELS: Record<string, string> = {
  core: "Core Pipeline",
  testing: "Testing",
  infra: "Infrastructure",
  data: "Data Sync",
};

const TAG_COLORS: Record<string, string> = {
  FEAT: "bg-cyan-500/15 text-cyan-400 border-cyan-500/25",
  FIX: "bg-red-500/15 text-red-400 border-red-500/25",
  CIVIC: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  SCORE: "bg-amber-500/15 text-amber-400 border-amber-500/25",
  DATA: "bg-violet-500/15 text-violet-400 border-violet-500/25",
  MOBILE: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  INFRA: "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",
  TEST: "bg-orange-500/15 text-orange-400 border-orange-500/25",
};

// ===== Props =====

export interface MonitoringDashboardProps {
  /** Additional log scripts available in the log viewer dropdown */
  logScripts?: { value: string; label: string }[];
  /** Additional tag colors for backlog item tags */
  tagColors?: Record<string, string>;
}

// ===== Helpers =====

function formatAge(ms: number | null): string {
  if (ms === null) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getLogLineColor(line: string): string {
  if (/FAILED|ERROR|error|FAIL/i.test(line)) return "text-red-400";
  if (/passed|merged|completed|success|MERGED/i.test(line)) return "text-emerald-400";
  if (/Starting|starting|kicked off|kicking off/i.test(line)) return "text-cyan-400";
  if (/WARNING|warn/i.test(line)) return "text-amber-400";
  return "text-zinc-400";
}

function getTagColor(tag: string, extraColors?: Record<string, string>): string {
  const merged = { ...TAG_COLORS, ...extraColors };
  return merged[tag] ?? "bg-zinc-500/15 text-zinc-400 border-zinc-500/25";
}

// ===== Sub-components =====

function SummaryCards({ status }: { status: MonitoringStatus }) {
  const runningCount = status.workers.filter((w) => w.running).length;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-cyan-400">Workers Active</p>
        <p className="mt-1 text-2xl font-bold text-white">
          {runningCount} <span className="text-sm font-normal text-zinc-500">/ {status.workers.length}</span>
        </p>
      </div>
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-amber-400">Backlog</p>
        <p className="mt-1 text-2xl font-bold text-white">
          {status.backlog.pendingCount}
          {status.backlog.claimedCount > 0 && (
            <span className="ml-2 text-sm font-normal text-amber-400">{status.backlog.claimedCount} claimed</span>
          )}
        </p>
      </div>
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-emerald-400">Completed</p>
        <p className="mt-1 text-2xl font-bold text-white">{status.completedCount}</p>
      </div>
      <div className={`rounded-xl border p-4 ${status.failedPendingCount > 0 ? "border-red-500/20 bg-red-500/5" : "border-zinc-800 bg-zinc-900"}`}>
        <p className={`text-xs font-medium uppercase tracking-wider ${status.failedPendingCount > 0 ? "text-red-400" : "text-zinc-500"}`}>
          Failed
        </p>
        <p className="mt-1 text-2xl font-bold text-white">{status.failed.length}</p>
      </div>
    </div>
  );
}

function PipelineFlow({ workers }: { workers: WorkerInfo[] }) {
  const getStatus = (name: string) => workers.find((w) => w.name === name);
  const dot = (name: string) => {
    const w = getStatus(name);
    if (!w) return "bg-zinc-600";
    return w.running ? "bg-emerald-400 animate-pulse" : "bg-zinc-600";
  };
  const border = (name: string) => {
    const w = getStatus(name);
    if (!w) return "border-zinc-800";
    return w.running ? "border-emerald-500/30 bg-emerald-500/5" : "border-zinc-800 bg-zinc-900";
  };

  const Node = ({ name, label, className }: { name: string; label: string; className?: string }) => (
    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${border(name)} ${className ?? ""}`}>
      <div className={`h-2 w-2 shrink-0 rounded-full ${dot(name)}`} />
      <span className="text-xs font-medium text-zinc-300">{label}</span>
      {getStatus(name)?.running && (
        <span className="text-xs text-emerald-400">{formatAge(getStatus(name)?.ageMs ?? null)}</span>
      )}
    </div>
  );

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <p className="mb-4 text-xs font-medium uppercase tracking-wider text-zinc-500">Pipeline Flow</p>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-6">
        {/* Infrastructure */}
        <div className="space-y-2">
          <p className="text-xs text-zinc-600">Infrastructure</p>
          <Node name="auth-refresh" label="Auth Refresh" />
          <div className="flex items-center gap-1 pl-4">
            <div className="h-4 w-px bg-zinc-700" />
          </div>
          <Node name="watchdog" label="Watchdog" />
        </div>

        {/* Arrow */}
        <div className="hidden items-center lg:flex">
          <div className="h-px w-8 bg-zinc-700" />
          <div className="h-0 w-0 border-y-4 border-l-4 border-y-transparent border-l-zinc-700" />
        </div>
        <div className="flex items-center justify-center lg:hidden">
          <div className="h-4 w-px bg-zinc-700" />
        </div>

        {/* Core Workers */}
        <div className="space-y-2">
          <p className="text-xs text-zinc-600">Core Workers</p>
          {workers.filter((w) => w.category === "core").map((w) => (
            <Node key={w.name} name={w.name} label={w.label} />
          ))}
        </div>

        {/* Arrow */}
        <div className="hidden items-center lg:flex">
          <div className="h-px w-8 bg-zinc-700" />
          <div className="h-0 w-0 border-y-4 border-l-4 border-y-transparent border-l-zinc-700" />
        </div>
        <div className="flex items-center justify-center lg:hidden">
          <div className="h-4 w-px bg-zinc-700" />
        </div>

        {/* Gates */}
        <div className="space-y-2">
          <p className="text-xs text-zinc-600">Quality Gates</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
            <span className="text-xs text-zinc-500">Typecheck</span>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
            <span className="text-xs text-zinc-500">Playwright</span>
          </div>
        </div>

        {/* Arrow */}
        <div className="hidden items-center lg:flex">
          <div className="h-px w-8 bg-zinc-700" />
          <div className="h-0 w-0 border-y-4 border-l-4 border-y-transparent border-l-zinc-700" />
        </div>
        <div className="flex items-center justify-center lg:hidden">
          <div className="h-4 w-px bg-zinc-700" />
        </div>

        {/* Output */}
        <div className="space-y-2">
          <p className="text-xs text-zinc-600">Output</p>
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
            <GitBranch className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-xs font-medium text-emerald-400">main</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkerCard({
  worker,
  onTrigger,
  onViewLogs,
  triggering,
}: {
  worker: WorkerInfo;
  onTrigger: () => void;
  onViewLogs: () => void;
  triggering: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 transition ${
        worker.running ? "border-emerald-500/30 bg-emerald-500/5" : "border-zinc-800 bg-zinc-900 hover:border-zinc-700"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${worker.running ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
          <span className="text-sm font-semibold text-white">{worker.label}</span>
        </div>
        {worker.running && <span className="text-xs text-emerald-400">{formatAge(worker.ageMs)}</span>}
      </div>
      <p className="mt-1 text-xs text-zinc-500">{worker.description}</p>
      <p className="mt-0.5 text-xs text-zinc-600">{worker.schedule}</p>
      {worker.running && worker.pid && <p className="mt-1 text-xs text-zinc-600">PID {worker.pid}</p>}
      {!worker.running && worker.lastLogTime && (
        <p className="mt-1.5 text-xs text-zinc-600">Last: {worker.lastLogTime}</p>
      )}
      <div className="mt-3 flex items-center gap-2">
        {worker.name !== "watchdog" && worker.name !== "auth-refresh" && (
          <button
            onClick={onTrigger}
            disabled={triggering}
            className="flex items-center gap-1 rounded-lg bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-400 transition hover:bg-cyan-500/20 disabled:opacity-50"
          >
            {triggering ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Run
          </button>
        )}
        <button
          onClick={onViewLogs}
          className="flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-400 transition hover:bg-zinc-700 hover:text-white"
        >
          <Terminal className="h-3 w-3" />
          Logs
        </button>
      </div>
    </div>
  );
}

function LogTerminal({
  logData,
  loading,
  autoScroll,
}: {
  logData: LogData | null;
  loading: boolean;
  autoScroll: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logData?.lines, autoScroll]);

  if (!logData || logData.lines.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-zinc-600">No log entries</p>;
  }

  return (
    <div className="max-h-[500px] overflow-y-auto bg-zinc-950 p-4 font-mono text-xs leading-relaxed">
      {logData.lines.map((line, i) => (
        <div key={i} className={`py-0.5 break-all ${getLogLineColor(line)}`}>
          {line}
        </div>
      ))}
      {loading && (
        <div className="flex items-center gap-2 py-1 text-zinc-600">
          <Loader2 className="h-3 w-3 animate-spin" />
          Refreshing...
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

// ===== Main Component =====

export function MonitoringDashboard({ logScripts: logScriptsProp, tagColors }: MonitoringDashboardProps = {}) {
  const { apiPrefix } = useSkynet();

  // Default log scripts - can be overridden via props
  const defaultLogScripts = [
    { value: "dev-worker-1", label: "Dev Worker 1" },
    { value: "dev-worker-2", label: "Dev Worker 2" },
    { value: "dev-worker", label: "Dev Worker (shared)" },
    { value: "project-driver", label: "Project Driver" },
    { value: "task-fixer", label: "Task Fixer" },
    { value: "watchdog", label: "Watchdog" },
    { value: "auth-refresh", label: "Auth Refresh" },
    { value: "health-check", label: "Health Check" },
    { value: "sync-runner", label: "Sync Runner" },
    { value: "post-commit-gate", label: "Post-Commit Gate" },
  ];
  const logScripts = logScriptsProp ?? defaultLogScripts;

  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [activeTaskTab, setActiveTaskTab] = useState<TaskTabId>("backlog");
  const [status, setStatus] = useState<MonitoringStatus | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [logData, setLogData] = useState<LogData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<Record<string, boolean>>({});
  const [triggerMsg, setTriggerMsg] = useState<Record<string, string>>({});
  const [selectedLog, setSelectedLog] = useState<string>(logScripts[0]?.value ?? "dev-worker-1");
  const [logSearch, setLogSearch] = useState("");
  const [logLines, setLogLines] = useState(200);
  const [logLoading, setLogLoading] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  // Fetch status
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/monitoring/status`);
      const json = await res.json();
      if (json.error) {
        setError(json.error);
        return;
      }
      setStatus(json.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  // Fetch agents
  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/monitoring/agents`);
      const json = await res.json();
      if (json.data) setAgents(json.data.agents);
    } catch { /* ignore */ }
  }, [apiPrefix]);

  // Fetch logs
  const fetchLogs = useCallback(
    async (script: string) => {
      setLogLoading(true);
      try {
        const params = new URLSearchParams({ script, lines: String(logLines) });
        if (logSearch) params.set("search", logSearch);
        const res = await fetch(`${apiPrefix}/monitoring/logs?${params}`);
        const json = await res.json();
        if (json.data) setLogData(json.data);
      } catch {
        setLogData(null);
      } finally {
        setLogLoading(false);
      }
    },
    [apiPrefix, logLines, logSearch]
  );

  // Poll status every 5s
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Poll logs every 3s when on logs tab
  useEffect(() => {
    if (activeTab !== "logs") return;
    fetchLogs(selectedLog);
    const interval = setInterval(() => fetchLogs(selectedLog), 3000);
    return () => clearInterval(interval);
  }, [activeTab, selectedLog, fetchLogs]);

  // Poll agents every 30s when on system tab
  useEffect(() => {
    if (activeTab !== "system") return;
    fetchAgents();
    const interval = setInterval(fetchAgents, 30000);
    return () => clearInterval(interval);
  }, [activeTab, fetchAgents]);

  async function triggerScript(script: string) {
    // Map worker names to script names the trigger endpoint expects
    const scriptMap: Record<string, string> = {
      "dev-worker-1": "dev-worker",
      "dev-worker-2": "dev-worker",
    };
    const triggerName = scriptMap[script] ?? script;

    setTriggering((p) => ({ ...p, [script]: true }));
    setTriggerMsg((p) => ({ ...p, [script]: "" }));
    try {
      const res = await fetch(`${apiPrefix}/pipeline/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: triggerName }),
      });
      const json = await res.json();
      if (json.error) {
        setTriggerMsg((p) => ({ ...p, [script]: `Error: ${json.error}` }));
      } else {
        setTriggerMsg((p) => ({ ...p, [script]: "Triggered!" }));
        setTimeout(() => fetchStatus(), 2000);
      }
    } catch {
      setTriggerMsg((p) => ({ ...p, [script]: "Failed" }));
    } finally {
      setTriggering((p) => ({ ...p, [script]: false }));
      setTimeout(() => setTriggerMsg((p) => ({ ...p, [script]: "" })), 4000);
    }
  }

  function switchToLogs(script: string) {
    setSelectedLog(script);
    setActiveTab("logs");
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        <span className="ml-3 text-sm text-zinc-500">Loading monitoring data...</span>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-6 py-4">
        <AlertTriangle className="h-5 w-5 text-red-400" />
        <p className="text-sm text-red-400">{error ?? "Failed to load"}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Tab navigation */}
      <div className="flex gap-1 overflow-x-auto border-b border-zinc-800">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition ${
                activeTab === tab.id
                  ? "border-cyan-400 text-white"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-6 py-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* ===== OVERVIEW TAB ===== */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          <SummaryCards status={status} />

          {/* Git & Post-Commit Status */}
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Git Status */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex items-center gap-2 mb-3">
                <GitBranch className="h-4 w-4 text-cyan-400" />
                <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Git Status</p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Branch</span>
                  <span className="text-xs font-mono text-cyan-400">{status.git.branch}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Commits ahead</span>
                  <span className={`text-xs font-mono ${status.git.commitsAhead > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                    {status.git.commitsAhead}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Dirty files</span>
                  <span className={`text-xs font-mono ${status.git.dirtyFiles > 0 ? "text-red-400" : "text-emerald-400"}`}>
                    {status.git.dirtyFiles}
                  </span>
                </div>
                {status.git.lastCommit && (
                  <div className="mt-1 truncate text-xs text-zinc-600 font-mono">{status.git.lastCommit}</div>
                )}
              </div>
            </div>

            {/* Post-Commit Gate */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex items-center gap-2 mb-3">
                <ShieldAlert className="h-4 w-4 text-violet-400" />
                <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Post-Commit Gate</p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Last result</span>
                  <span className={`text-xs font-semibold ${
                    status.postCommitGate.lastResult === "pass" ? "text-emerald-400" :
                    status.postCommitGate.lastResult === "fail" ? "text-red-400" :
                    "text-zinc-500"
                  }`}>
                    {status.postCommitGate.lastResult ?? "N/A"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Last commit</span>
                  <span className="text-xs font-mono text-zinc-400 truncate max-w-[160px]">
                    {status.postCommitGate.lastCommit?.slice(0, 7) ?? "N/A"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Last run</span>
                  <span className="text-xs text-zinc-400">
                    {status.postCommitGate.lastTime ?? "N/A"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Blockers alert */}
          {status.hasBlockers && (
            <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-6 py-4">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
              <div>
                <p className="text-sm font-semibold text-red-400">Active Blockers</p>
                {status.blockerLines.map((line, i) => (
                  <p key={i} className="mt-1 text-xs text-red-300">{line}</p>
                ))}
              </div>
            </div>
          )}

          {/* Auth warning */}
          {status.auth.authFailFlag && (
            <div className="flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-6 py-4">
              <Key className="h-5 w-5 text-red-400" />
              <div>
                <p className="text-sm font-semibold text-red-400">Authentication Failed</p>
                <p className="mt-0.5 text-xs text-red-300">
                  Claude Code auth is down. Run <code className="rounded bg-zinc-800 px-1">claude</code> then <code className="rounded bg-zinc-800 px-1">/login</code> to restore.
                </p>
              </div>
            </div>
          )}

          <PipelineFlow workers={status.workers} />

          {/* Current tasks */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                <Zap className="h-3.5 w-3.5" />
                Worker 1
              </div>
              {status.currentTask.status === "in_progress" ? (
                <div className="mt-3">
                  <p className="text-sm font-semibold text-emerald-400">{status.currentTask.title}</p>
                  {status.currentTask.branch && (
                    <p className="mt-1 text-xs text-zinc-500">
                      <GitBranch className="mr-1 inline h-3 w-3" />
                      {status.currentTask.branch}
                    </p>
                  )}
                  {status.currentTask.started && (
                    <p className="mt-0.5 text-xs text-zinc-500">Started: {status.currentTask.started}</p>
                  )}
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-sm text-zinc-500">Idle</p>
                  {status.currentTask.lastInfo && (
                    <p className="mt-1 truncate text-xs text-zinc-600">{status.currentTask.lastInfo}</p>
                  )}
                </div>
              )}
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                <Zap className="h-3.5 w-3.5" />
                Worker 2
              </div>
              {status.workers.find((w) => w.name === "dev-worker-2")?.running ? (
                <div className="mt-3">
                  <p className="text-sm font-semibold text-emerald-400">Running</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    PID {status.workers.find((w) => w.name === "dev-worker-2")?.pid} &middot;{" "}
                    {formatAge(status.workers.find((w) => w.name === "dev-worker-2")?.ageMs ?? null)}
                  </p>
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-sm text-zinc-500">Idle</p>
                  <p className="mt-1 text-xs text-zinc-600">
                    Activates when backlog has 2+ tasks
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Recent activity */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
              <Activity className="h-4 w-4 text-cyan-400" />
              <span className="text-sm font-semibold text-white">Recent Activity</span>
            </div>
            <div className="divide-y divide-zinc-800/50">
              {[...status.completed.slice(-5).map((t) => ({ ...t, type: "completed" as const })),
                ...status.failed.slice(-5).map((t) => ({ ...t, notes: t.error, type: "failed" as const }))]
                .sort((a, b) => b.date.localeCompare(a.date))
                .slice(0, 10)
                .map((item, i) => (
                  <div key={i} className="flex items-center justify-between px-5 py-3">
                    <div className="flex items-center gap-2">
                      {item.type === "completed" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500/60" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-red-500/60" />
                      )}
                      <span className="text-sm text-zinc-300">{item.task}</span>
                    </div>
                    <span className="shrink-0 text-xs text-zinc-600">{item.date}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* ===== WORKERS TAB ===== */}
      {activeTab === "workers" && (
        <div className="space-y-6">
          <SummaryCards status={status} />

          {(["core", "testing", "infra", "data"] as const).map((category) => {
            const categoryWorkers = status.workers.filter((w) => w.category === category);
            if (categoryWorkers.length === 0) return null;
            return (
              <div key={category}>
                <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
                  {CATEGORY_LABELS[category]}
                </h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {categoryWorkers.map((w) => (
                    <div key={w.name}>
                      <WorkerCard
                        worker={w}
                        onTrigger={() => triggerScript(w.name)}
                        onViewLogs={() => switchToLogs(w.logFile)}
                        triggering={!!triggering[w.name]}
                      />
                      {triggerMsg[w.name] && (
                        <p className={`mt-1 px-1 text-xs ${triggerMsg[w.name].startsWith("Error") ? "text-red-400" : "text-emerald-400"}`}>
                          {triggerMsg[w.name]}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ===== TASKS TAB ===== */}
      {activeTab === "tasks" && (
        <div className="space-y-4">
          {/* Sub-tabs */}
          <div className="flex gap-1">
            {TASK_TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTaskTab(tab)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition ${
                  activeTaskTab === tab
                    ? "bg-cyan-500/10 text-cyan-400"
                    : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                }`}
              >
                {tab}
                {tab === "backlog" && (
                  <span className="ml-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-400">{status.backlog.pendingCount}</span>
                )}
                {tab === "failed" && status.failedPendingCount > 0 && (
                  <span className="ml-1.5 rounded bg-red-500/10 px-1.5 py-0.5 text-red-400">{status.failedPendingCount}</span>
                )}
              </button>
            ))}
          </div>

          {/* Backlog */}
          {activeTaskTab === "backlog" && (
            <div className="rounded-xl border border-zinc-800 overflow-hidden">
              <div className="divide-y divide-zinc-800/50">
                {status.backlog.items.filter((i) => i.status !== "done").length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-zinc-500">Backlog is empty</p>
                ) : (
                  status.backlog.items
                    .filter((i) => i.status !== "done")
                    .map((item, i) => (
                      <div key={i} className="flex items-start gap-3 bg-zinc-900/50 px-5 py-3">
                        <span className="mt-0.5 shrink-0 text-xs text-zinc-600">{i + 1}.</span>
                        {item.status === "claimed" && (
                          <span className="mt-0.5 shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-400 border border-amber-500/25">
                            CLAIMED
                          </span>
                        )}
                        {item.tag && (
                          <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-xs font-medium ${getTagColor(item.tag, tagColors)}`}>
                            {item.tag}
                          </span>
                        )}
                        <span className="text-sm text-zinc-300">{item.text.replace(/^\[[^\]]+\]\s*/, "").replace(/\s*\|\s*blockedBy:.*$/i, "")}</span>
                      </div>
                    ))
                )}
              </div>
            </div>
          )}

          {/* Completed */}
          {activeTaskTab === "completed" && (
            <div className="rounded-xl border border-zinc-800 overflow-hidden">
              <div className="divide-y divide-zinc-800/50">
                {status.completed.length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-zinc-500">No completed tasks</p>
                ) : (
                  [...status.completed].reverse().map((task, i) => (
                    <div key={i} className="flex items-center justify-between bg-zinc-900/50 px-5 py-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500/50" />
                        <span className="truncate text-sm text-zinc-300">{task.task}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-xs text-zinc-600">{task.notes}</span>
                        <span className="text-xs text-zinc-600">{task.date}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Failed */}
          {activeTaskTab === "failed" && (
            <div className="rounded-xl border border-zinc-800 overflow-hidden">
              <div className="divide-y divide-zinc-800/50">
                {status.failed.length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-zinc-500">No failed tasks</p>
                ) : (
                  status.failed.map((task, i) => (
                    <div key={i} className="bg-zinc-900/50 px-5 py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500/50" />
                          <span className="truncate text-sm text-zinc-300">{task.task}</span>
                        </div>
                        <span
                          className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${
                            task.status.includes("pending")
                              ? "border-amber-500/25 bg-amber-500/15 text-amber-400"
                              : task.status.includes("fixed")
                                ? "border-emerald-500/25 bg-emerald-500/15 text-emerald-400"
                                : "border-red-500/25 bg-red-500/15 text-red-400"
                          }`}
                        >
                          {task.status.trim()}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">
                        {task.error} &middot; Attempts: {task.attempts} &middot; {task.date}
                      </p>
                      {task.branch && (
                        <p className="mt-0.5 text-xs text-zinc-600">
                          <GitBranch className="mr-1 inline h-3 w-3" />
                          {task.branch}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Blockers */}
          {activeTaskTab === "blockers" && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
              {status.hasBlockers ? (
                <div className="space-y-2">
                  {status.blockerLines.map((line, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                      <p className="text-sm text-red-300">{line}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 py-8">
                  <CheckCircle2 className="h-8 w-8 text-emerald-500/40" />
                  <p className="text-sm text-emerald-400">No Active Blockers</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ===== LOGS TAB ===== */}
      {activeTab === "logs" && (
        <div className="space-y-4">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={selectedLog}
              onChange={(e) => {
                setSelectedLog(e.target.value);
                setLogData(null);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-cyan-500 focus:outline-none"
            >
              {logScripts.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                placeholder="Search logs..."
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-white placeholder-zinc-600 focus:border-cyan-500 focus:outline-none"
              />
              {logSearch && (
                <button
                  onClick={() => setLogSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <select
              value={logLines}
              onChange={(e) => setLogLines(Number(e.target.value))}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-cyan-500 focus:outline-none"
            >
              <option value={100}>100 lines</option>
              <option value={200}>200 lines</option>
              <option value={500}>500 lines</option>
              <option value={1000}>1000 lines</option>
            </select>

            <button
              onClick={() => fetchLogs(selectedLog)}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-400 transition hover:border-zinc-600 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>

            <button
              onClick={() => setAutoScroll(!autoScroll)}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                autoScroll
                  ? "bg-cyan-500/10 text-cyan-400"
                  : "border border-zinc-700 bg-zinc-900 text-zinc-500"
              }`}
            >
              Auto-scroll {autoScroll ? "ON" : "OFF"}
            </button>
          </div>

          {/* File info */}
          {logData && (
            <div className="flex items-center gap-3 text-xs text-zinc-600">
              <span>{logData.script}.log</span>
              <span>&middot;</span>
              <span>{logData.totalLines.toLocaleString()} total lines</span>
              <span>&middot;</span>
              <span>{formatBytes(logData.fileSizeBytes)}</span>
              <span>&middot;</span>
              <span>Showing last {logData.lines.length}</span>
              {logLoading && <Loader2 className="h-3 w-3 animate-spin" />}
            </div>
          )}

          {/* Terminal */}
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            <LogTerminal logData={logData} loading={logLoading} autoScroll={autoScroll} />
          </div>
        </div>
      )}

      {/* ===== SYSTEM TAB ===== */}
      {activeTab === "system" && (
        <div className="space-y-6">
          {/* Auth status */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
              <Key className="h-3.5 w-3.5" />
              Authentication
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-zinc-500">Token Cache</p>
                <div className="mt-1 flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${status.auth.tokenCached ? "bg-emerald-400" : "bg-red-400"}`} />
                  <span className="text-sm text-white">
                    {status.auth.tokenCached ? "Cached" : "Missing"}
                  </span>
                </div>
                {status.auth.tokenCacheAgeMs !== null && (
                  <p className="mt-0.5 text-xs text-zinc-600">Updated {formatAge(status.auth.tokenCacheAgeMs)} ago</p>
                )}
              </div>
              <div>
                <p className="text-xs text-zinc-500">Auth Status</p>
                <div className="mt-1 flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${status.auth.authFailFlag ? "bg-red-400 animate-pulse" : "bg-emerald-400"}`} />
                  <span className={`text-sm ${status.auth.authFailFlag ? "text-red-400" : "text-white"}`}>
                    {status.auth.authFailFlag ? "Failed" : "OK"}
                  </span>
                </div>
                {status.auth.lastFailEpoch && (
                  <p className="mt-0.5 text-xs text-zinc-600">
                    Last fail: {formatAge(Date.now() - status.auth.lastFailEpoch * 1000)} ago
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs text-zinc-500">Backlog Mutex</p>
                <div className="mt-1 flex items-center gap-2">
                  {status.backlogLocked ? (
                    <>
                      <Lock className="h-3.5 w-3.5 text-amber-400" />
                      <span className="text-sm text-amber-400">Locked</span>
                    </>
                  ) : (
                    <>
                      <div className="h-2 w-2 rounded-full bg-zinc-600" />
                      <span className="text-sm text-zinc-400">Unlocked</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* LaunchAgents */}
          <div className="rounded-xl border border-zinc-800 overflow-hidden">
            <div className="flex items-center gap-2 bg-zinc-900 px-5 py-3 border-b border-zinc-800">
              <Settings className="h-4 w-4 text-cyan-400" />
              <span className="text-sm font-semibold text-white">LaunchAgents</span>
            </div>
            {!agents ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
              </div>
            ) : (
              <div className="divide-y divide-zinc-800/50">
                {agents.map((agent) => (
                  <div key={agent.label} className="flex items-center justify-between bg-zinc-900/50 px-5 py-3">
                    <div className="flex items-center gap-3">
                      <div className={`h-2 w-2 rounded-full ${agent.loaded ? "bg-emerald-400" : "bg-zinc-600"}`} />
                      <div>
                        <p className="text-sm text-zinc-300">{agent.name}</p>
                        <p className="text-xs text-zinc-600">{agent.label}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      {agent.intervalHuman && (
                        <span className="text-xs text-zinc-500">{agent.intervalHuman}</span>
                      )}
                      {agent.runAtLoad && (
                        <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-xs text-cyan-400">RunAtLoad</span>
                      )}
                      <span
                        className={`rounded-md border px-2 py-0.5 text-xs font-medium ${
                          agent.loaded
                            ? "border-emerald-500/25 bg-emerald-500/15 text-emerald-400"
                            : agent.plistExists
                              ? "border-zinc-700 bg-zinc-800 text-zinc-500"
                              : "border-red-500/25 bg-red-500/15 text-red-400"
                        }`}
                      >
                        {agent.loaded ? "Loaded" : agent.plistExists ? "Unloaded" : "No plist"}
                      </span>
                      {agent.lastExitStatus !== null && agent.lastExitStatus !== 0 && (
                        <span className="text-xs text-red-400">exit {agent.lastExitStatus}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Lock files */}
          <div className="rounded-xl border border-zinc-800 overflow-hidden">
            <div className="flex items-center gap-2 bg-zinc-900 px-5 py-3 border-b border-zinc-800">
              <Lock className="h-4 w-4 text-cyan-400" />
              <span className="text-sm font-semibold text-white">Lock Files</span>
            </div>
            <div className="grid gap-px bg-zinc-800/50 sm:grid-cols-2 lg:grid-cols-3">
              {status.workers.map((w) => (
                <div key={w.name} className="flex items-center justify-between bg-zinc-900 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className={`h-2 w-2 rounded-full ${w.running ? "bg-emerald-400" : "bg-zinc-700"}`} />
                    <span className="text-xs text-zinc-400">{w.name}</span>
                  </div>
                  {w.running ? (
                    <span className="text-xs text-emerald-400">PID {w.pid}</span>
                  ) : (
                    <span className="text-xs text-zinc-700">idle</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Sync health */}
          <div className="rounded-xl border border-zinc-800 overflow-hidden">
            <div className="flex items-center justify-between bg-zinc-900 px-5 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-cyan-400" />
                <span className="text-sm font-semibold text-white">Sync Health</span>
              </div>
              {status.syncHealth.lastRun && (
                <span className="text-xs text-zinc-600">Last run: {status.syncHealth.lastRun}</span>
              )}
            </div>
            <div className="divide-y divide-zinc-800/50">
              {status.syncHealth.endpoints.map((s, i) => (
                <div key={i} className="flex items-center justify-between bg-zinc-900/50 px-5 py-3">
                  <div className="flex items-center gap-3">
                    {s.status === "ok" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    ) : s.status === "error" ? (
                      <XCircle className="h-3.5 w-3.5 text-red-400" />
                    ) : (
                      <Clock className="h-3.5 w-3.5 text-zinc-500" />
                    )}
                    <span className="text-sm text-zinc-300">{s.endpoint}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-xs text-zinc-500">{s.records}</span>
                    <span className="hidden text-xs text-zinc-600 sm:block">{s.notes}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <p className="text-center text-xs text-zinc-700">
        Status: 5s &middot; Logs: 3s &middot; Agents: 30s &middot;{" "}
        {status.timestamp && new Date(status.timestamp).toLocaleTimeString()}
      </p>
    </div>
  );
}
