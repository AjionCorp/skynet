"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Play,
  Clock,
  TrendingDown,
  CheckCircle2,
  Circle,
  BarChart3,
} from "lucide-react";
import type { ProjectDriverStatus } from "../types";
import { useSkynet } from "./SkynetProvider";

export interface ProjectDriverDashboardProps {
  pollInterval?: number;
}

export function ProjectDriverDashboard({ pollInterval = 15_000 }: ProjectDriverDashboardProps = {}) {
  const { apiPrefix } = useSkynet();

  const [status, setStatus] = useState<ProjectDriverStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/project-driver/status`);
      const json = await res.json();
      if (json.error) {
        setError(json.error);
      } else {
        setStatus(json.data);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, pollInterval);
    return () => clearInterval(interval);
  }, [fetchStatus, pollInterval]);

  const triggerRun = useCallback(async () => {
    setTriggering(true);
    setTriggerMsg(null);
    try {
      const res = await fetch(`${apiPrefix}/pipeline/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: "project-driver" }),
      });
      const json = await res.json();
      if (json.error) {
        setTriggerMsg(`Error: ${json.error}`);
      } else {
        setTriggerMsg("Project driver triggered");
        setTimeout(fetchStatus, 2000);
      }
    } catch (err) {
      setTriggerMsg(err instanceof Error ? err.message : "Trigger failed");
    } finally {
      setTriggering(false);
    }
  }, [apiPrefix, fetchStatus]);

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        <span className="ml-3 text-sm text-zinc-500">Loading project driver status...</span>
      </div>
    );
  }

  const t = status?.telemetry;
  const fixRatePct = t
    ? (t.fixRate <= 1 ? Math.round(t.fixRate * 100) : Math.round(t.fixRate))
    : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className="h-5 w-5 text-cyan-400" />
          <h1 className="text-xl font-bold text-white">Project Driver</h1>
          {status?.running ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Running
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-400">
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
              Idle
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={triggerRun}
            disabled={triggering || status?.running === true}
            className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-400 transition hover:border-cyan-500/50 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {triggering ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Trigger Run
          </button>
          <button
            onClick={fetchStatus}
            className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-400 transition hover:border-zinc-700 hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Trigger message */}
      {triggerMsg && (
        <div className={`rounded-lg border px-4 py-2 text-sm ${
          triggerMsg.startsWith("Error")
            ? "border-red-500/20 bg-red-500/10 text-red-400"
            : "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
        }`}>
          {triggerMsg}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-6 py-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Low fix rate mode warning */}
      {t?.driver_low_fix_rate_mode && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-6 py-4">
          <TrendingDown className="h-5 w-5 shrink-0 text-amber-400" />
          <div>
            <p className="text-sm font-medium text-amber-300">Low Fix Rate Mode Active</p>
            <p className="text-xs text-amber-400/70">
              Task generation is biased toward reliability and reconciliation work
            </p>
          </div>
        </div>
      )}

      {/* Telemetry cards */}
      {t ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Pending Backlog"
            value={t.pendingBacklog}
            icon={<Circle className="h-4 w-4 text-zinc-400" />}
          />
          <MetricCard
            label="Claimed"
            value={t.claimedBacklog}
            icon={<CheckCircle2 className="h-4 w-4 text-cyan-400" />}
          />
          <MetricCard
            label="Pending Retries"
            value={t.pendingRetries}
            icon={<AlertTriangle className="h-4 w-4 text-amber-400" />}
            warn={t.pendingRetries > 10}
          />
          <MetricCard
            label="Fix Rate"
            value={fixRatePct !== null ? `${fixRatePct}%` : "\u2014"}
            icon={<BarChart3 className="h-4 w-4 text-emerald-400" />}
            warn={fixRatePct !== null && fixRatePct < 50}
          />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 py-12">
          <Brain className="h-8 w-8 text-zinc-600" />
          <p className="mt-3 text-sm font-medium text-zinc-400">No telemetry available</p>
          <p className="mt-1 text-xs text-zinc-600">
            Telemetry appears after the project driver runs
          </p>
        </div>
      )}

      {/* Additional metrics row */}
      {t && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Duplicates Skipped
            </p>
            <p className="mt-1 text-2xl font-bold text-white">{t.duplicateSkipped}</p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Max New Tasks
            </p>
            <p className="mt-1 text-2xl font-bold text-white">{t.maxNewTasks}</p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Last Run
            </p>
            <p className="mt-1 text-lg font-bold text-white">
              {t.ts ? new Date(t.ts).toLocaleString() : "—"}
            </p>
          </div>
        </div>
      )}

      {/* Last log line */}
      {status?.lastLog && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Clock className="h-4 w-4 text-zinc-500" />
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Last Log Entry
              {status.lastLogTime && (
                <span className="ml-2 normal-case text-zinc-600">{status.lastLogTime}</span>
              )}
            </p>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-400">
            {status.lastLog}
          </pre>
        </div>
      )}

      {/* Runtime info */}
      {status?.running && status.pid && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Process Info
          </p>
          <p className="mt-1 text-sm text-zinc-300">
            PID {status.pid}
            {status.ageMs != null && (
              <span className="ml-2 text-zinc-500">
                running for {Math.round(status.ageMs / 1000 / 60)}m
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  icon,
  warn,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        warn
          ? "border-amber-500/20 bg-amber-500/5"
          : "border-zinc-800 bg-zinc-900/50"
      }`}
    >
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          {label}
        </p>
      </div>
      <p className={`mt-1 text-2xl font-bold ${warn ? "text-amber-400" : "text-white"}`}>
        {value}
      </p>
    </div>
  );
}
