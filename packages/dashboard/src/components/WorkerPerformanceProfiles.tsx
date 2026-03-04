"use client";

import {
  CheckCircle2,
  XCircle,
  Timer,
  Target,
  ChevronDown,
  ChevronRight,
  Users,
} from "lucide-react";
import { useState } from "react";
import type { WorkerPerformanceStats } from "../types";

export interface WorkerPerformanceProfilesProps {
  workerStats: Record<string, WorkerPerformanceStats>;
}

function SuccessBar({ rate }: { rate: number }) {
  const color =
    rate >= 80
      ? "bg-emerald-500"
      : rate >= 60
        ? "bg-amber-500"
        : "bg-red-500";
  return (
    <div className="h-1.5 w-full rounded-full bg-zinc-800">
      <div
        className={`h-1.5 rounded-full ${color} transition-all`}
        style={{ width: `${rate}%` }}
      />
    </div>
  );
}

export function WorkerPerformanceProfiles({
  workerStats,
}: WorkerPerformanceProfilesProps) {
  const [expanded, setExpanded] = useState(false);

  const entries = Object.entries(workerStats).sort(([a], [b]) => {
    const numA = parseInt(a.replace("worker-", ""), 10);
    const numB = parseInt(b.replace("worker-", ""), 10);
    return numA - numB;
  });

  if (entries.length === 0) return null;

  // Aggregate stats
  const totalCompleted = entries.reduce((s, [, v]) => s + v.completedCount, 0);
  const totalFailed = entries.reduce((s, [, v]) => s + v.failedCount, 0);
  const totalAttempted = totalCompleted + totalFailed;
  const overallRate =
    totalAttempted > 0 ? Math.round((totalCompleted / totalAttempted) * 100) : 0;

  // Find best/worst performers (only workers with at least 1 task)
  const active = entries.filter(
    ([, v]) => v.completedCount + v.failedCount > 0,
  );
  const best = active.length > 0
    ? active.reduce((a, b) => (b[1].successRate > a[1].successRate ? b : a))
    : null;
  const worst = active.length > 1
    ? active.reduce((a, b) => (b[1].successRate < a[1].successRate ? b : a))
    : null;

  return (
    <div className="rounded-xl border border-zinc-800 overflow-hidden">
      <button
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center justify-between bg-zinc-900 px-5 py-3 text-left transition hover:bg-zinc-800/70"
      >
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-violet-400" />
          <span className="text-sm font-semibold text-white">
            Worker Performance Profiles
          </span>
          <span className="rounded-md bg-violet-500/10 px-2 py-0.5 text-xs text-violet-400">
            {active.length} active
          </span>
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-zinc-500" />
        ) : (
          <ChevronRight className="h-4 w-4 text-zinc-500" />
        )}
      </button>
      {expanded && (
        <div className="bg-zinc-900/50 px-5 py-4 space-y-4">
          {/* Summary row */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Overall Success
              </p>
              <p className="mt-0.5 text-lg font-bold text-white">
                {totalAttempted > 0 ? `${overallRate}%` : "--"}
              </p>
            </div>
            {best && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-emerald-400">
                  Top Performer
                </p>
                <p className="mt-0.5 text-lg font-bold text-white">
                  W{best[0].replace("worker-", "")}{" "}
                  <span className="text-sm font-normal text-emerald-400">
                    {best[1].successRate}%
                  </span>
                </p>
              </div>
            )}
            {worst && worst[0] !== best?.[0] && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-amber-400">
                  Needs Attention
                </p>
                <p className="mt-0.5 text-lg font-bold text-white">
                  W{worst[0].replace("worker-", "")}{" "}
                  <span className="text-sm font-normal text-amber-400">
                    {worst[1].successRate}%
                  </span>
                </p>
              </div>
            )}
          </div>

          {/* Per-worker profiles */}
          <div className="grid gap-3 sm:grid-cols-2">
            {entries.map(([key, stats]) => {
              const wid = key.replace("worker-", "");
              const total = stats.completedCount + stats.failedCount;
              const hasData = total > 0;
              const rateLevel: "high" | "medium" | "low" =
                stats.successRate >= 80
                  ? "high"
                  : stats.successRate >= 60
                    ? "medium"
                    : "low";
              const borderColor = !hasData
                ? "border-zinc-800"
                : rateLevel === "high"
                  ? "border-emerald-500/20"
                  : rateLevel === "medium"
                    ? "border-amber-500/20"
                    : "border-red-500/20";

              return (
                <div
                  key={key}
                  className={`rounded-lg border ${borderColor} bg-zinc-900 p-4`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white">
                      Worker {wid}
                    </span>
                    {hasData && (
                      <span
                        className={`text-xs font-medium ${
                          rateLevel === "high"
                            ? "text-emerald-400"
                            : rateLevel === "medium"
                              ? "text-amber-400"
                              : "text-red-400"
                        }`}
                      >
                        {stats.successRate}%
                      </span>
                    )}
                  </div>
                  {hasData ? (
                    <>
                      <div className="mt-2">
                        <SuccessBar rate={stats.successRate} />
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                        <div>
                          <div className="flex items-center justify-center gap-1">
                            <CheckCircle2 className="h-3 w-3 text-emerald-500/60" />
                            <span className="text-sm font-bold text-white">
                              {stats.completedCount}
                            </span>
                          </div>
                          <p className="text-[10px] text-zinc-600">Completed</p>
                        </div>
                        <div>
                          <div className="flex items-center justify-center gap-1">
                            <XCircle className="h-3 w-3 text-red-500/60" />
                            <span className="text-sm font-bold text-white">
                              {stats.failedCount}
                            </span>
                          </div>
                          <p className="text-[10px] text-zinc-600">Failed</p>
                        </div>
                        <div>
                          <div className="flex items-center justify-center gap-1">
                            <Timer className="h-3 w-3 text-violet-500/60" />
                            <span className="text-sm font-bold text-white">
                              {stats.avgDuration ?? "--"}
                            </span>
                          </div>
                          <p className="text-[10px] text-zinc-600">Avg Time</p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 text-xs text-zinc-600">No tasks yet</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
