"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Target,
  CheckCircle2,
  Circle,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Crosshair,
  FileText,
} from "lucide-react";
import type { MissionStatus, MissionProgress } from "../types";
import { useSkynet } from "./SkynetProvider";

export interface MissionDashboardProps {
  /** Poll interval in milliseconds. Defaults to 30000 (30s). */
  pollInterval?: number;
}

const statusBadge: Record<MissionProgress["status"], { label: string; classes: string }> = {
  met: { label: "Met", classes: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  partial: { label: "Partial", classes: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  "not-met": { label: "Not Met", classes: "bg-red-500/10 text-red-400 border-red-500/20" },
};

export function MissionDashboard({ pollInterval = 30_000 }: MissionDashboardProps = {}) {
  const { apiPrefix } = useSkynet();

  const [mission, setMission] = useState<MissionStatus | null>(null);
  const [missionProgress, setMissionProgress] = useState<MissionProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMission = useCallback(async () => {
    try {
      const [missionRes, pipelineRes] = await Promise.all([
        fetch(`${apiPrefix}/mission/status`),
        fetch(`${apiPrefix}/pipeline/status`),
      ]);
      const missionJson = await missionRes.json();
      const pipelineJson = await pipelineRes.json();

      if (missionJson.error) {
        setError(missionJson.error);
      } else {
        setMission(missionJson.data);
        setError(null);
      }

      if (pipelineJson.data?.missionProgress) {
        setMissionProgress(pipelineJson.data.missionProgress);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch mission status");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchMission();
    const interval = setInterval(fetchMission, pollInterval);
    return () => clearInterval(interval);
  }, [fetchMission, pollInterval]);

  if (loading && !mission) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        <span className="ml-3 text-sm text-zinc-500">Loading mission status...</span>
      </div>
    );
  }

  const completedCriteria = mission?.successCriteria.filter((c) => c.completed).length ?? 0;
  const totalCriteria = mission?.successCriteria.length ?? 0;
  const completedGoals = mission?.goals.filter((g) => g.completed).length ?? 0;
  const totalGoals = mission?.goals.length ?? 0;
  const percentage = mission?.completionPercentage ?? 0;

  return (
    <div className="space-y-6">
      {/* Progress overview cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Completion percentage */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Mission Progress
          </p>
          <p className="mt-1 text-2xl font-bold text-white">{percentage}%</p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                percentage === 100
                  ? "bg-emerald-500"
                  : percentage >= 50
                    ? "bg-cyan-500"
                    : "bg-amber-500"
              }`}
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>

        {/* Success criteria count */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Success Criteria
          </p>
          <p className="mt-1 text-2xl font-bold text-white">
            {completedCriteria}
            <span className="text-sm font-normal text-zinc-500"> / {totalCriteria}</span>
          </p>
        </div>

        {/* Goals count */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Goals
          </p>
          <p className="mt-1 text-2xl font-bold text-white">
            {completedGoals}
            <span className="text-sm font-normal text-zinc-500"> / {totalGoals}</span>
          </p>
        </div>

        {/* Status */}
        <div
          className={`rounded-xl border p-4 ${
            percentage === 100
              ? "border-emerald-500/20 bg-emerald-500/5"
              : "border-zinc-800 bg-zinc-900/50"
          }`}
        >
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Status
          </p>
          <p
            className={`mt-1 text-2xl font-bold ${
              percentage === 100 ? "text-emerald-400" : "text-white"
            }`}
          >
            {percentage === 100 ? "Complete" : "In Progress"}
          </p>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-6 py-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Refresh button */}
      <div className="flex justify-end">
        <button
          onClick={fetchMission}
          className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-400 transition hover:border-zinc-700 hover:text-white"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Empty state */}
      {!mission?.raw && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 py-16">
          <Target className="h-8 w-8 text-zinc-600" />
          <p className="mt-3 text-sm font-medium text-zinc-400">No mission defined</p>
          <p className="mt-1 text-xs text-zinc-600">
            Create .dev/mission.md with Purpose, Goals, and Success Criteria sections
          </p>
        </div>
      )}

      {mission?.raw && (
        <>
          {/* Raw mission.md content */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
            <div className="mb-4 flex items-center gap-2">
              <FileText className="h-4 w-4 text-cyan-400" />
              <h2 className="text-lg font-semibold text-white">Mission Document</h2>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm leading-relaxed text-zinc-300">
              {mission.raw}
            </pre>
          </div>

          {/* Mission Progress Table */}
          {missionProgress.length > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
              <div className="mb-4 flex items-center gap-2">
                <Target className="h-4 w-4 text-cyan-400" />
                <h2 className="text-lg font-semibold text-white">Progress by Criterion</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className="pb-3 pr-4 text-xs font-medium uppercase tracking-wider text-zinc-500">#</th>
                      <th className="pb-3 pr-4 text-xs font-medium uppercase tracking-wider text-zinc-500">Criterion</th>
                      <th className="pb-3 pr-4 text-xs font-medium uppercase tracking-wider text-zinc-500">Status</th>
                      <th className="pb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">Evidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/50">
                    {missionProgress.map((mp) => {
                      const badge = statusBadge[mp.status];
                      return (
                        <tr key={mp.id}>
                          <td className="py-3 pr-4 text-zinc-500">{mp.id}</td>
                          <td className="py-3 pr-4 text-zinc-300">{mp.criterion}</td>
                          <td className="py-3 pr-4">
                            <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.classes}`}>
                              {badge.label}
                            </span>
                          </td>
                          <td className="py-3 text-zinc-400">{mp.evidence}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Purpose */}
          {mission.purpose && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
              <div className="mb-3 flex items-center gap-2">
                <Target className="h-4 w-4 text-cyan-400" />
                <h2 className="text-lg font-semibold text-white">Purpose</h2>
              </div>
              <p className="text-sm leading-relaxed text-zinc-300">{mission.purpose}</p>
            </div>
          )}

          {/* Success Criteria */}
          {mission.successCriteria.length > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
              <div className="mb-4 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                <h2 className="text-lg font-semibold text-white">Success Criteria</h2>
                <span className="ml-auto text-xs text-zinc-500">
                  {completedCriteria} of {totalCriteria} met
                </span>
              </div>
              <div className="space-y-2">
                {mission.successCriteria.map((criterion, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
                      criterion.completed
                        ? "border-emerald-500/20 bg-emerald-500/5"
                        : "border-zinc-800 bg-zinc-900"
                    }`}
                  >
                    {criterion.completed ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
                    )}
                    <span
                      className={`text-sm ${
                        criterion.completed ? "text-emerald-300" : "text-zinc-300"
                      }`}
                    >
                      {criterion.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Goals */}
          {mission.goals.length > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
              <div className="mb-4 flex items-center gap-2">
                <Target className="h-4 w-4 text-cyan-400" />
                <h2 className="text-lg font-semibold text-white">Goals</h2>
                <span className="ml-auto text-xs text-zinc-500">
                  {completedGoals} of {totalGoals} achieved
                </span>
              </div>
              <div className="space-y-2">
                {mission.goals.map((goal, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
                      goal.completed
                        ? "border-emerald-500/20 bg-emerald-500/5"
                        : "border-zinc-800 bg-zinc-900"
                    }`}
                  >
                    {goal.completed ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
                    )}
                    <span
                      className={`text-sm ${
                        goal.completed ? "text-emerald-300" : "text-zinc-300"
                      }`}
                    >
                      {goal.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Current Focus */}
          {mission.currentFocus && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-6">
              <div className="mb-3 flex items-center gap-2">
                <Crosshair className="h-4 w-4 text-amber-400" />
                <h2 className="text-lg font-semibold text-white">Current Focus</h2>
              </div>
              <p className="text-sm leading-relaxed text-amber-200/80">{mission.currentFocus}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
