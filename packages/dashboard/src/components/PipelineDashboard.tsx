"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  GitBranch,
  HeartPulse,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  AlertTriangle,
  ListTodo,
  RefreshCw,
  Terminal,
  X,
  Zap,
  ShieldAlert,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { PipelineStatus } from "../types";
import { useSkynet } from "./SkynetProvider";
import { ActivityFeed } from "./ActivityFeed";

function formatAge(ms: number | null): string {
  if (ms === null) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function extractTimestamp(logLine: string | null): string | null {
  if (!logLine) return null;
  const match = logLine.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
  return match?.[1] ?? null;
}

export function PipelineDashboard() {
  const { apiPrefix } = useSkynet();
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<Record<string, boolean>>({});
  const [triggerMsg, setTriggerMsg] = useState<Record<string, string>>({});
  const [logViewer, setLogViewer] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    backlog: true,
    completed: false,
    sync: false,
  });
  const logEndRef = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/pipeline/status`);
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

  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  const esRef = useRef<EventSource | null>(null);
  const backoffRef = useRef(1000);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchLogs = useCallback(async (script: string) => {
    setLogLoading(true);
    try {
      const res = await fetch(`${apiPrefix}/pipeline/logs?script=${script}&lines=100`);
      const json = await res.json();
      setLogLines(json.data?.lines ?? []);
    } catch {
      setLogLines(["Failed to load logs"]);
    } finally {
      setLogLoading(false);
    }
  }, [apiPrefix]);

  // Stream status via SSE with exponential backoff reconnection
  useEffect(() => {
    const BACKOFF_MAX = 30000;

    function connect() {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      const es = new EventSource(`${apiPrefix}/pipeline/stream`);
      esRef.current = es;

      es.onopen = () => {
        setConnectionStatus('connected');
        backoffRef.current = 1000;
      };

      es.onmessage = (event) => {
        try {
          const json = JSON.parse(event.data);
          if (json.error) {
            setError(json.error);
            return;
          }
          setStatus(json.data);
          setError(null);
          setConnectionStatus('connected');
        } catch {
          /* ignore malformed frames */
        } finally {
          setLoading(false);
        }
        backoffRef.current = 1000;
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setConnectionStatus('reconnecting');
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, BACKOFF_MAX);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    // Close SSE when tab is hidden, reopen when visible
    function handleVisibility() {
      if (document.hidden) {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }
        setConnectionStatus('disconnected');
      } else {
        backoffRef.current = 1000;
        connect();
      }
    }

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (esRef.current) {
        esRef.current.close();
      }
    };
  }, [apiPrefix]);

  // Poll logs every 3s when viewer is open
  useEffect(() => {
    if (!logViewer) return;
    fetchLogs(logViewer);
    const interval = setInterval(() => fetchLogs(logViewer), 3000);
    return () => clearInterval(interval);
  }, [logViewer, fetchLogs]);

  // Auto-scroll log viewer
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines]);

  async function triggerScript(script: string) {
    setTriggering((p) => ({ ...p, [script]: true }));
    setTriggerMsg((p) => ({ ...p, [script]: "" }));
    try {
      const res = await fetch(`${apiPrefix}/pipeline/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      const json = await res.json();
      if (json.error) {
        setTriggerMsg((p) => ({ ...p, [script]: `Error: ${json.error}` }));
      } else {
        setTriggerMsg((p) => ({ ...p, [script]: "Triggered!" }));
        setTimeout(() => fetchStatus(), 2000);
      }
    } catch {
      setTriggerMsg((p) => ({ ...p, [script]: "Failed to trigger" }));
    } finally {
      setTriggering((p) => ({ ...p, [script]: false }));
      setTimeout(() => setTriggerMsg((p) => ({ ...p, [script]: "" })), 4000);
    }
  }

  function toggleSection(key: string) {
    setExpandedSections((p) => ({ ...p, [key]: !p[key] }));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        <span className="ml-3 text-sm text-zinc-500">Loading pipeline status...</span>
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

  const runningCount = status.workers.filter((w) => w.running).length;
  const healthLevel =
    status.healthScore > 80
      ? "high"
      : status.healthScore > 50
        ? "medium"
        : "low";
  const scrLevel =
    status.selfCorrectionRate >= 90
      ? "high"
      : status.selfCorrectionRate >= 70
        ? "medium"
        : "low";
  const levelClasses = {
    high: { card: 'border-emerald-500/20 bg-emerald-500/5', label: 'text-emerald-400', badge: 'bg-emerald-500/20 text-emerald-400' },
    medium: { card: 'border-amber-500/20 bg-amber-500/5', label: 'text-amber-400', badge: 'bg-amber-500/20 text-amber-400' },
    low: { card: 'border-red-500/20 bg-red-500/5', label: 'text-red-400', badge: 'bg-red-500/20 text-red-400' },
  } as const;

  return (
    <div className="space-y-6">
      {/* Connection status indicator */}
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold text-white">Pipeline Dashboard</h1>
        <div className="flex items-center gap-1.5" title={
          connectionStatus === 'connected' ? 'Live — receiving updates' :
          connectionStatus === 'reconnecting' ? 'Reconnecting…' : 'Disconnected'
        }>
          <div className={`h-2 w-2 rounded-full ${
            connectionStatus === 'connected' ? 'bg-emerald-400' :
            connectionStatus === 'reconnecting' ? 'bg-amber-400 animate-pulse' : 'bg-red-400'
          }`} />
          {connectionStatus !== 'connected' && (
            <span className={`text-xs ${
              connectionStatus === 'reconnecting' ? 'text-amber-400' : 'text-red-400'
            }`}>
              {connectionStatus === 'reconnecting' ? 'Reconnecting…' : 'Disconnected'}
            </span>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <div className={`rounded-xl border p-4 ${levelClasses[healthLevel].card}`}>
          <p className={`text-xs font-medium uppercase tracking-wider ${levelClasses[healthLevel].label}`}>Health</p>
          <div className="mt-1 flex items-center gap-2">
            <p className="text-2xl font-bold text-white">{status.healthScore}</p>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${levelClasses[healthLevel].badge}`}>
              {status.healthScore > 80 ? "Good" : status.healthScore > 50 ? "Degraded" : "Critical"}
            </span>
          </div>
        </div>
        <div className={`rounded-xl border p-4 ${levelClasses[scrLevel].card}`}>
          <p className={`text-xs font-medium uppercase tracking-wider ${levelClasses[scrLevel].label}`}>Self-Correction</p>
          <div className="mt-1 flex items-center gap-2">
            <p className="text-2xl font-bold text-white">{status.selfCorrectionRate}%</p>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${levelClasses[scrLevel].badge}`}>
              {status.selfCorrectionStats.fixed} fixed + {status.selfCorrectionStats.superseded} routed around
            </span>
          </div>
        </div>
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-cyan-400">Workers Active</p>
          <p className="mt-1 text-2xl font-bold text-white">{runningCount} / {status.workers.length}</p>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-amber-400">Backlog</p>
          <p className="mt-1 text-2xl font-bold text-white">{status.backlog.pendingCount}</p>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-emerald-400">Completed</p>
          <p className="mt-1 text-2xl font-bold text-white">{status.completedCount}</p>
        </div>
        <div className={`rounded-xl border p-4 ${status.failedPendingCount > 0 ? "border-red-500/20 bg-red-500/5" : "border-zinc-800 bg-zinc-900"}`}>
          <p className={`text-xs font-medium uppercase tracking-wider ${status.failedPendingCount > 0 ? "text-red-400" : "text-zinc-500"}`}>Failed</p>
          <p className="mt-1 text-2xl font-bold text-white">{status.failedPendingCount}</p>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-6 py-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

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

      {/* Current Tasks (per-worker) */}
      <div className="grid gap-4 sm:grid-cols-2">
        {Object.entries(status.currentTasks ?? {}).map(([key, task]) => {
          const wid = key.replace("worker-", "");
          const hb = status.heartbeats?.[key];
          return (
            <div key={key} className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                  <Zap className="h-3.5 w-3.5" />
                  Worker {wid}
                </div>
                {hb?.lastEpoch != null && (
                  <div className={`flex items-center gap-1 text-xs ${hb.isStale ? "text-red-400" : "text-emerald-400"}`}>
                    <HeartPulse className="h-3 w-3" />
                    {hb.isStale ? "Stale" : formatAge(hb.ageMs)}
                  </div>
                )}
              </div>
              {task.status === "in_progress" || task.status === "working" ? (
                <div className="mt-3">
                  <p className="text-sm font-semibold text-emerald-400">{task.title}</p>
                  {task.branch && (
                    <p className="mt-1 text-xs text-zinc-500">
                      <GitBranch className="mr-1 inline h-3 w-3" />
                      {task.branch}
                    </p>
                  )}
                  {task.started && (
                    <p className="mt-0.5 text-xs text-zinc-500">Started: {task.started}</p>
                  )}
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-sm text-zinc-500">{task.status === "completed" ? "Completed" : "Idle"}</p>
                  {task.lastInfo && (
                    <p className="mt-1 text-xs text-zinc-600 truncate">{task.lastInfo}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {/* Fallback: show legacy single task if no per-worker tasks */}
        {(!status.currentTasks || Object.keys(status.currentTasks).length === 0) && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 sm:col-span-2">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
              <Zap className="h-3.5 w-3.5" />
              Current Task
            </div>
            {status.currentTask.status === "in_progress" ? (
              <div className="mt-3">
                <p className="text-sm font-semibold text-emerald-400">{status.currentTask.title}</p>
                {status.currentTask.branch && (
                  <p className="mt-1 text-xs text-zinc-500">Branch: {status.currentTask.branch}</p>
                )}
                {status.currentTask.started && (
                  <p className="mt-0.5 text-xs text-zinc-500">Started: {status.currentTask.started}</p>
                )}
              </div>
            ) : (
              <div className="mt-3">
                <p className="text-sm text-zinc-500">Idle</p>
                {status.currentTask.lastInfo && (
                  <p className="mt-1 text-xs text-zinc-600 truncate">{status.currentTask.lastInfo}</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Workers Grid */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Workers</h2>
          <button
            onClick={fetchStatus}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-white"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {status.workers.map((w) => (
            <div
              key={w.name}
              className={`rounded-xl border p-4 transition ${
                w.running
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-zinc-800 bg-zinc-900 hover:border-zinc-700"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${w.running ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
                  <span className="text-sm font-semibold text-white">{w.label}</span>
                </div>
                {w.running && (
                  <span className="text-xs text-emerald-400">{formatAge(w.ageMs)}</span>
                )}
              </div>
              <p className="mt-1 text-xs text-zinc-500">{w.description}</p>
              <p className="mt-0.5 text-xs text-zinc-600">{w.schedule}</p>
              {w.running && w.pid && (
                <p className="mt-1 text-xs text-zinc-600">PID {w.pid}</p>
              )}
              {!w.running && w.lastLog && (
                <p className="mt-1.5 truncate text-xs text-zinc-600" title={w.lastLog}>
                  Last: {extractTimestamp(w.lastLog) ?? "\u2014"}
                </p>
              )}
              <div className="mt-3 flex items-center gap-2">
                {w.name !== "watchdog" && (
                  <button
                    onClick={() => triggerScript(w.name)}
                    disabled={triggering[w.name]}
                    className="flex items-center gap-1 rounded-lg bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-400 transition hover:bg-cyan-500/20 disabled:opacity-50"
                  >
                    {triggering[w.name] ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                    Run
                  </button>
                )}
                <button
                  onClick={() => setLogViewer(logViewer === w.name ? null : w.name)}
                  className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                    logViewer === w.name
                      ? "bg-amber-500/20 text-amber-400"
                      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                  }`}
                >
                  <Terminal className="h-3 w-3" />
                  Logs
                </button>
              </div>
              {triggerMsg[w.name] && (
                <p className={`mt-2 text-xs ${triggerMsg[w.name].startsWith("Error") ? "text-red-400" : "text-emerald-400"}`}>
                  {triggerMsg[w.name]}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Log Viewer */}
      {logViewer && (
        <div className="rounded-xl border border-amber-500/20 bg-zinc-900">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-semibold text-white">{logViewer}.log</span>
              {logLoading && <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => fetchLogs(logViewer)}
                className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-white"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setLogViewer(null)}
                className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-zinc-400">
            {logLines.length === 0 ? (
              <p className="text-zinc-600">No log entries</p>
            ) : (
              logLines.map((line, i) => (
                <div
                  key={i}
                  className={`py-0.5 ${
                    line.includes("FAILED") || line.includes("ERROR") || line.includes("error")
                      ? "text-red-400"
                      : line.includes("passed") || line.includes("merged") || line.includes("completed")
                        ? "text-emerald-400"
                        : line.includes("Starting") || line.includes("starting")
                          ? "text-cyan-400"
                          : ""
                  }`}
                >
                  {line}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {/* Backlog */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <button
          onClick={() => toggleSection("backlog")}
          className="flex w-full items-center justify-between bg-zinc-900 px-5 py-3 text-left transition hover:bg-zinc-800/70"
        >
          <div className="flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-white">Backlog</span>
            <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">{status.backlog.pendingCount}</span>
          </div>
          {expandedSections.backlog ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
        </button>
        {expandedSections.backlog && (
          <div className="divide-y divide-zinc-800/50">
            {status.backlog.items.length === 0 ? (
              <p className="px-5 py-3 text-sm text-zinc-500">Backlog is empty</p>
            ) : (
              status.backlog.items.filter((t) => t.status !== "done").map((task, i) => (
                <div key={i} className="flex items-start gap-3 bg-zinc-900/50 px-5 py-3">
                  <span className="mt-0.5 text-xs text-zinc-600">{i + 1}.</span>
                  <div className="flex items-center gap-2">
                    {task.tag && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{task.tag}</span>}
                    <span className={`text-sm ${task.status === "claimed" ? "text-cyan-400" : "text-zinc-300"}`}>{task.text.replace(/\s*\|\s*blockedBy:.*$/i, "")}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Recent Completed */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <button
          onClick={() => toggleSection("completed")}
          className="flex w-full items-center justify-between bg-zinc-900 px-5 py-3 text-left transition hover:bg-zinc-800/70"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <span className="text-sm font-semibold text-white">Completed</span>
            <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">{status.completedCount}</span>
          </div>
          {expandedSections.completed ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
        </button>
        {expandedSections.completed && (
          <div className="divide-y divide-zinc-800/50">
            {status.completed.map((task, i) => (
              <div key={i} className="flex items-center justify-between bg-zinc-900/50 px-5 py-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500/50" />
                  <span className="text-sm text-zinc-300">{task.task}</span>
                </div>
                <span className="text-xs text-zinc-600">{task.date}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Failed Tasks */}
      {status.failed.length > 0 && (
        <div className="rounded-xl border border-red-500/20 overflow-hidden">
          <div className="flex items-center gap-2 bg-red-500/5 px-5 py-3">
            <XCircle className="h-4 w-4 text-red-400" />
            <span className="text-sm font-semibold text-red-400">Failed Tasks</span>
            <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-xs text-red-400">{status.failedPendingCount}</span>
          </div>
          <div className="divide-y divide-red-500/10">
            {status.failed.filter((f) => f.status.includes("pending")).map((task, i) => (
              <div key={i} className="bg-zinc-900/50 px-5 py-3">
                <p className="text-sm text-zinc-300">{task.task}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  {task.error} &middot; Attempt {task.attempts}/3 &middot; {task.date}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sync Health */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <button
          onClick={() => toggleSection("sync")}
          className="flex w-full items-center justify-between bg-zinc-900 px-5 py-3 text-left transition hover:bg-zinc-800/70"
        >
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-cyan-400" />
            <span className="text-sm font-semibold text-white">Sync Health</span>
            {status.syncHealth.lastRun && (
              <span className="text-xs text-zinc-600">Last: {status.syncHealth.lastRun}</span>
            )}
          </div>
          {expandedSections.sync ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
        </button>
        {expandedSections.sync && (
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
                  <span className="text-xs text-zinc-600">{s.notes}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Activity Feed */}
      <ActivityFeed />

      {/* Footer */}
      <p className="text-center text-xs text-zinc-700">
        {connectionStatus === 'connected' ? 'Live updates via SSE' :
         connectionStatus === 'reconnecting' ? 'Reconnecting to SSE\u2026' : 'SSE disconnected'} &middot; Logs refresh every 3s when open
      </p>
    </div>
  );
}
