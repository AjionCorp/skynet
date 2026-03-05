"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Ban,
  RotateCcw,
  Users,
} from "lucide-react";
import { useSkynet } from "./SkynetProvider";
import type {
  FailureAnalysis,
  ErrorPattern,
  FailureTimelinePoint,
  WorkerFailureStats,
} from "../types";

export interface FailureAnalysisPanelProps {}

export function FailureAnalysisPanel(_props: FailureAnalysisPanelProps) {
  const { apiPrefix } = useSkynet();
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<FailureAnalysis | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/pipeline/failure-analysis`);
      const json = await res.json();
      if (json.data) setData(json.data);
    } catch {
      // non-critical
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (!data || data.summary.total === 0) return null;

  const fixRate =
    data.summary.total > 0
      ? Math.round((data.summary.selfCorrected / data.summary.total) * 100)
      : 0;

  return (
    <div className="rounded-xl border border-zinc-800 overflow-hidden">
      <button
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center justify-between bg-zinc-900 px-5 py-3 text-left transition hover:bg-zinc-800/70"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-red-400" />
          <span className="text-sm font-semibold text-white">
            Failure Analysis
          </span>
          <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
            {data.summary.total} total
          </span>
          {data.summary.pending > 0 && (
            <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">
              {data.summary.pending} pending
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-zinc-500" />
        ) : (
          <ChevronRight className="h-4 w-4 text-zinc-500" />
        )}
      </button>
      {expanded && (
        <div className="bg-zinc-900/50 px-5 py-4 space-y-4">
          {/* Summary cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Total Failures
              </p>
              <p className="mt-0.5 text-lg font-bold text-white">
                {data.summary.total}
              </p>
            </div>
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-emerald-400">
                Fixed
              </p>
              <p className="mt-0.5 text-lg font-bold text-emerald-400">
                {data.summary.fixed}
              </p>
            </div>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-amber-400">
                Blocked
              </p>
              <p className="mt-0.5 text-lg font-bold text-amber-400">
                {data.summary.blocked}
              </p>
            </div>
            <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-cyan-400">
                Superseded
              </p>
              <p className="mt-0.5 text-lg font-bold text-cyan-400">
                {data.summary.superseded}
              </p>
            </div>
            <div
              className={`rounded-lg border p-3 ${
                fixRate >= 80
                  ? "border-emerald-500/20 bg-emerald-500/5"
                  : fixRate >= 50
                    ? "border-amber-500/20 bg-amber-500/5"
                    : "border-red-500/20 bg-red-500/5"
              }`}
            >
              <p
                className={`text-[11px] font-medium uppercase tracking-wider ${
                  fixRate >= 80
                    ? "text-emerald-400"
                    : fixRate >= 50
                      ? "text-amber-400"
                      : "text-red-400"
                }`}
              >
                Self-Correction
              </p>
              <p
                className={`mt-0.5 text-lg font-bold ${
                  fixRate >= 80
                    ? "text-emerald-400"
                    : fixRate >= 50
                      ? "text-amber-400"
                      : "text-red-400"
                }`}
              >
                {fixRate}%
              </p>
            </div>
          </div>

          {/* Error patterns */}
          {data.errorPatterns.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Error Patterns
              </p>
              <div className="overflow-hidden rounded-lg border border-zinc-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-zinc-900 text-[11px] uppercase tracking-wider text-zinc-500">
                      <th className="px-3 py-2 text-left font-medium">
                        Pattern
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Count
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        Tasks
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/50">
                    {data.errorPatterns.map((ep: ErrorPattern) => (
                      <tr key={ep.pattern} className="bg-zinc-900/50">
                        <td className="px-3 py-2 font-medium text-red-400">
                          <span className="inline-flex items-center gap-1.5">
                            <AlertCircle className="h-3 w-3" />
                            {ep.pattern}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-white">
                          {ep.count}
                        </td>
                        <td className="px-3 py-2 text-zinc-400">
                          <span className="truncate block max-w-[200px]">
                            {ep.tasks.slice(0, 3).join(", ")}
                            {ep.tasks.length > 3 &&
                              ` +${ep.tasks.length - 3} more`}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Failure timeline */}
          {data.timeline.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Failure Timeline (last {data.timeline.length} days)
              </p>
              <div className="flex items-end gap-1 h-20">
                {data.timeline.map((point: FailureTimelinePoint) => {
                  const max = Math.max(
                    ...data.timeline.map((t) => t.failures),
                    1,
                  );
                  const height = Math.max(
                    (point.failures / max) * 100,
                    point.failures > 0 ? 8 : 2,
                  );
                  return (
                    <div
                      key={point.date}
                      className="flex-1 flex flex-col items-center gap-1"
                    >
                      <div
                        className={`w-full rounded-sm ${
                          point.failures > 0
                            ? point.fixed >= point.failures
                              ? "bg-emerald-500/40"
                              : "bg-red-500/40"
                            : "bg-zinc-800"
                        }`}
                        style={{ height: `${height}%` }}
                        title={`${point.date}: ${point.failures} failures, ${point.fixed} fixed`}
                      />
                      <span className="text-[9px] text-zinc-600">
                        {point.date.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex items-center gap-4 text-[10px] text-zinc-600">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-sm bg-red-500/40" /> Unfixed
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-sm bg-emerald-500/40" /> All
                  fixed
                </span>
              </div>
            </div>
          )}

          {/* Per-worker stats */}
          {data.byWorker.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Failures by Worker
              </p>
              <div className="overflow-hidden rounded-lg border border-zinc-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-zinc-900 text-[11px] uppercase tracking-wider text-zinc-500">
                      <th className="px-3 py-2 text-left font-medium">
                        Worker
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Failures
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Fixed
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Fix Rate
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Avg Attempts
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/50">
                    {data.byWorker.map((w: WorkerFailureStats) => {
                      const workerFixRate =
                        w.failures > 0
                          ? Math.round((w.fixed / w.failures) * 100)
                          : 0;
                      const rateColor =
                        workerFixRate >= 80
                          ? "text-emerald-400"
                          : workerFixRate >= 50
                            ? "text-amber-400"
                            : "text-red-400";
                      return (
                        <tr key={w.workerId} className="bg-zinc-900/50">
                          <td className="px-3 py-2 font-medium text-white">
                            <span className="inline-flex items-center gap-1.5">
                              <Users className="h-3 w-3 text-zinc-600" />W
                              {w.workerId}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right text-red-400">
                            {w.failures}
                          </td>
                          <td className="px-3 py-2 text-right text-emerald-400">
                            {w.fixed}
                          </td>
                          <td className={`px-3 py-2 text-right ${rateColor}`}>
                            {workerFixRate}%
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-400">
                            {w.avgAttempts.toFixed(1)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Recent failures */}
          {data.recentFailures.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Recent Failures
              </p>
              <div className="space-y-2">
                {data.recentFailures.slice(0, 5).map((f, i) => {
                  const statusIcon =
                    f.status === "fixed" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    ) : f.status === "blocked" ? (
                      <Ban className="h-3.5 w-3.5 text-amber-400" />
                    ) : f.status.includes("pending") ? (
                      <RotateCcw className="h-3.5 w-3.5 text-red-400" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 text-zinc-500" />
                    );
                  const statusColor =
                    f.status === "fixed"
                      ? "text-emerald-400"
                      : f.status === "blocked"
                        ? "text-amber-400"
                        : f.status.includes("pending")
                          ? "text-red-400"
                          : "text-zinc-400";
                  return (
                    <div
                      key={i}
                      className="rounded-lg border border-zinc-800 bg-zinc-900 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-zinc-300">
                          {f.task}
                        </p>
                        <span
                          className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs ${statusColor}`}
                        >
                          {statusIcon}
                          {f.status}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">
                        {f.error} &middot; Attempt {f.attempts} &middot;{" "}
                        {f.date}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
