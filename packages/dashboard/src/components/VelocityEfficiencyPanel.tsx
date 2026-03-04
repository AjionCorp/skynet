"use client";

import { useCallback, useEffect, useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Zap,
  ChevronDown,
  ChevronRight,
  BarChart3,
  Clock,
} from "lucide-react";
import { useSkynet } from "./SkynetProvider";
import type { VelocityDataPoint, WorkerPerformanceStats } from "../types";

export interface VelocityEfficiencyPanelProps {
  workerStats: Record<string, WorkerPerformanceStats>;
}

function parseDurationToMins(dur: string | null): number | null {
  if (!dur) return null;
  const hm = dur.match(/^(\d+)h\s+(\d+)m$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const h = dur.match(/^(\d+)h$/);
  if (h) return Number(h[1]) * 60;
  const m = dur.match(/^(\d+)m$/);
  if (m) return Number(m[1]);
  return null;
}

export function VelocityEfficiencyPanel({
  workerStats,
}: VelocityEfficiencyPanelProps) {
  const { apiPrefix } = useSkynet();
  const [expanded, setExpanded] = useState(false);
  const [velocity, setVelocity] = useState<VelocityDataPoint[]>([]);

  const fetchVelocity = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/pipeline/task-velocity`);
      const json = await res.json();
      if (Array.isArray(json.data)) setVelocity(json.data);
    } catch {
      // non-critical
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchVelocity();
    const interval = setInterval(fetchVelocity, 60000);
    return () => clearInterval(interval);
  }, [fetchVelocity]);

  // Compute velocity metrics
  const total = velocity.reduce((s, d) => s + d.count, 0);
  const avgPerDay =
    velocity.length > 0 ? Math.round((total / velocity.length) * 10) / 10 : 0;

  // Last 7 days vs prior 7 days
  const recent7 = velocity.slice(-7);
  const prior7 = velocity.slice(-14, -7);
  const recent7Total = recent7.reduce((s, d) => s + d.count, 0);
  const prior7Total = prior7.reduce((s, d) => s + d.count, 0);
  const velocityChange =
    prior7Total > 0
      ? Math.round(((recent7Total - prior7Total) / prior7Total) * 100)
      : null;

  // Peak day
  const peakDay =
    velocity.length > 0
      ? velocity.reduce((best, d) => (d.count > best.count ? d : best))
      : null;

  // Avg duration across all velocity data points
  const daysWithDur = velocity.filter((d) => d.avgDurationMins !== null);
  const avgDurationMins =
    daysWithDur.length > 0
      ? Math.round(
          daysWithDur.reduce((s, d) => s + (d.avgDurationMins ?? 0), 0) /
            daysWithDur.length,
        )
      : null;

  // Worker efficiency metrics
  const workerEntries = Object.entries(workerStats)
    .filter(([, s]) => s.completedCount + s.failedCount > 0)
    .sort(([a], [b]) => {
      const na = parseInt(a.replace("worker-", ""), 10);
      const nb = parseInt(b.replace("worker-", ""), 10);
      return na - nb;
    });

  // Per-worker tasks/hour (efficiency)
  const workerEfficiency = workerEntries.map(([key, stats]) => {
    const mins = parseDurationToMins(stats.avgDuration);
    const tasksPerHour = mins && mins > 0 ? Math.round((60 / mins) * 10) / 10 : null;
    return { key, stats, tasksPerHour };
  });

  const bestEfficiency = workerEfficiency
    .filter((w) => w.tasksPerHour !== null)
    .sort((a, b) => (b.tasksPerHour ?? 0) - (a.tasksPerHour ?? 0));

  const hasData = velocity.length > 0 || workerEntries.length > 0;
  if (!hasData) return null;

  const trendIcon =
    velocityChange !== null && velocityChange > 5 ? (
      <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
    ) : velocityChange !== null && velocityChange < -5 ? (
      <TrendingDown className="h-3.5 w-3.5 text-red-400" />
    ) : (
      <Minus className="h-3.5 w-3.5 text-zinc-500" />
    );

  const trendColor =
    velocityChange !== null && velocityChange > 5
      ? "text-emerald-400"
      : velocityChange !== null && velocityChange < -5
        ? "text-red-400"
        : "text-zinc-400";

  return (
    <div className="rounded-xl border border-zinc-800 overflow-hidden">
      <button
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center justify-between bg-zinc-900 px-5 py-3 text-left transition hover:bg-zinc-800/70"
      >
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-cyan-400" />
          <span className="text-sm font-semibold text-white">
            Velocity &amp; Worker Efficiency
          </span>
          {velocityChange !== null && (
            <span
              className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ${
                velocityChange > 5
                  ? "bg-emerald-500/10 text-emerald-400"
                  : velocityChange < -5
                    ? "bg-red-500/10 text-red-400"
                    : "bg-zinc-500/10 text-zinc-400"
              }`}
            >
              {trendIcon}
              {velocityChange > 0 ? "+" : ""}
              {velocityChange}% WoW
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
          {/* Velocity summary cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                7-Day Velocity
              </p>
              <div className="mt-0.5 flex items-center gap-2">
                <p className="text-lg font-bold text-white">
                  {recent7Total}{" "}
                  <span className="text-sm font-normal text-zinc-500">
                    tasks
                  </span>
                </p>
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Avg / Day
              </p>
              <p className="mt-0.5 text-lg font-bold text-white">{avgPerDay}</p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Week-over-Week
              </p>
              <div className="mt-0.5 flex items-center gap-1.5">
                {trendIcon}
                <p className={`text-lg font-bold ${trendColor}`}>
                  {velocityChange !== null
                    ? `${velocityChange > 0 ? "+" : ""}${velocityChange}%`
                    : "--"}
                </p>
              </div>
            </div>
            {peakDay && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                  Peak Day
                </p>
                <p className="mt-0.5 text-lg font-bold text-white">
                  {peakDay.count}{" "}
                  <span className="text-sm font-normal text-zinc-500">
                    on {peakDay.date.slice(5)}
                  </span>
                </p>
              </div>
            )}
          </div>

          {/* Worker efficiency table */}
          {workerEfficiency.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Worker Efficiency
              </p>
              <div className="overflow-hidden rounded-lg border border-zinc-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-zinc-900 text-[11px] uppercase tracking-wider text-zinc-500">
                      <th className="px-3 py-2 text-left font-medium">
                        Worker
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Completed
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Failed
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Success
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Avg Time
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Tasks/hr
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/50">
                    {workerEfficiency.map((w) => {
                      const wid = w.key.replace("worker-", "");
                      const rateColor =
                        w.stats.successRate >= 80
                          ? "text-emerald-400"
                          : w.stats.successRate >= 60
                            ? "text-amber-400"
                            : "text-red-400";
                      const isBest =
                        bestEfficiency.length > 0 &&
                        bestEfficiency[0].key === w.key;
                      return (
                        <tr key={w.key} className="bg-zinc-900/50">
                          <td className="px-3 py-2 font-medium text-white">
                            W{wid}
                            {isBest && (
                              <Zap className="ml-1 inline h-3 w-3 text-amber-400" />
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-emerald-400">
                            {w.stats.completedCount}
                          </td>
                          <td className="px-3 py-2 text-right text-red-400">
                            {w.stats.failedCount}
                          </td>
                          <td className={`px-3 py-2 text-right ${rateColor}`}>
                            {w.stats.successRate}%
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-400">
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-3 w-3 text-zinc-600" />
                              {w.stats.avgDuration ?? "--"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-cyan-400">
                            {w.tasksPerHour !== null ? w.tasksPerHour : "--"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Avg duration across days */}
          {avgDurationMins !== null && (
            <p className="text-xs text-zinc-500">
              Average task duration across{" "}
              {daysWithDur.length} day{daysWithDur.length !== 1 ? "s" : ""}:{" "}
              <span className="font-medium text-zinc-400">
                {avgDurationMins >= 60
                  ? `${Math.floor(avgDurationMins / 60)}h ${avgDurationMins % 60}m`
                  : `${avgDurationMins}m`}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
