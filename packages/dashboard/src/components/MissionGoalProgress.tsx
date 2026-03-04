"use client";

import {
  Target,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSkynet } from "./SkynetProvider";
import type { MissionProgress, GoalBurndownEntry, GoalBurndownPoint } from "../types";

export interface MissionGoalProgressProps {
  missionProgress: MissionProgress[];
  alignmentScore: number;
}

const statusConfig = {
  met: {
    icon: CheckCircle2,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    label: "Met",
  },
  partial: {
    icon: AlertTriangle,
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    label: "Partial",
  },
  "not-met": {
    icon: XCircle,
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/20",
    label: "Not Met",
  },
} as const;

/** Render an inline SVG sparkline for burndown data. */
function BurndownSparkline({ points }: { points: GoalBurndownPoint[] }) {
  if (points.length < 2) return null;

  const w = 120;
  const h = 24;
  const maxVal = Math.max(...points.map((p) => p.completed), 1);
  const coords = points.map((p, i) => ({
    x: (i / (points.length - 1)) * w,
    y: h - (p.completed / maxVal) * (h - 4) - 2,
  }));
  const pathD = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");

  return (
    <svg width={w} height={h} className="shrink-0">
      <path d={pathD} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-violet-400" />
      {coords.length > 0 && (
        <circle
          cx={coords[coords.length - 1].x}
          cy={coords[coords.length - 1].y}
          r="2"
          className="fill-violet-400"
        />
      )}
    </svg>
  );
}

/** Format ETA as human-readable string. */
function formatEta(etaDays: number | null, etaDate: string | null): string | null {
  if (etaDays === null || etaDate === null) return null;
  if (etaDays === 0) return "Done";
  if (etaDays === 1) return "~1 day";
  if (etaDays < 7) return `~${etaDays} days`;
  const weeks = Math.round(etaDays / 7);
  return weeks === 1 ? "~1 week" : `~${weeks} weeks`;
}

export function MissionGoalProgress({
  missionProgress,
  alignmentScore,
}: MissionGoalProgressProps) {
  const { apiPrefix } = useSkynet();
  const [expanded, setExpanded] = useState(true);
  const [burndownData, setBurndownData] = useState<GoalBurndownEntry[]>([]);

  const fetchBurndown = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/mission/goal-burndown`);
      if (!res.ok) return;
      const json = await res.json() as { data: GoalBurndownEntry[] | null };
      if (json.data) setBurndownData(json.data);
    } catch { /* ignore fetch errors */ }
  }, [apiPrefix]);

  useEffect(() => {
    fetchBurndown();
    const interval = setInterval(fetchBurndown, 60_000);
    return () => clearInterval(interval);
  }, [fetchBurndown]);

  if (missionProgress.length === 0) return null;

  const metCount = missionProgress.filter((p) => p.status === "met").length;
  const partialCount = missionProgress.filter((p) => p.status === "partial").length;
  const total = missionProgress.length;

  const alignLevel =
    alignmentScore >= 80 ? "emerald" : alignmentScore >= 50 ? "amber" : "red";

  // Match burndown entries to criteria by index
  const getBurndown = (idx: number): GoalBurndownEntry | undefined =>
    burndownData.find((b) => b.goalIndex === idx);

  return (
    <div className="rounded-xl border border-zinc-800 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between bg-zinc-900 px-5 py-3 text-left transition hover:bg-zinc-800/70"
      >
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-violet-400" />
          <span className="text-sm font-semibold text-white">Mission Goal Progress</span>
          <span className="rounded-md bg-violet-500/10 px-2 py-0.5 text-xs text-violet-400">
            {metCount}/{total} met
          </span>
          {partialCount > 0 && (
            <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">
              {partialCount} partial
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs font-medium text-${alignLevel}-400`}>
            {alignmentScore}% aligned
          </span>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-zinc-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-zinc-500" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="divide-y divide-zinc-800/50">
          {/* Alignment score bar */}
          <div className="bg-zinc-900/50 px-5 py-3">
            <div className="flex items-center justify-between text-xs text-zinc-500 mb-1.5">
              <span>Mission Alignment</span>
              <span className={`font-medium text-${alignLevel}-400`}>{alignmentScore}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-zinc-800">
              <div
                className={`h-1.5 rounded-full transition-all ${
                  alignmentScore >= 80
                    ? "bg-emerald-500"
                    : alignmentScore >= 50
                      ? "bg-amber-500"
                      : "bg-red-500"
                }`}
                style={{ width: `${Math.min(alignmentScore, 100)}%` }}
              />
            </div>
          </div>

          {/* Individual criteria with burndown */}
          {missionProgress.map((item, idx) => {
            const cfg = statusConfig[item.status];
            const Icon = cfg.icon;
            const bd = getBurndown(idx);
            const eta = bd ? formatEta(bd.etaDays, bd.etaDate) : null;

            return (
              <div key={item.id} className="bg-zinc-900/50 px-5 py-3">
                <div className="flex items-start gap-3">
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${cfg.color}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-zinc-300">{item.criterion}</p>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${cfg.bg} ${cfg.color}`}
                      >
                        {cfg.label}
                      </span>
                    </div>
                    {item.evidence && (
                      <p className="mt-1 text-xs text-zinc-500">{item.evidence}</p>
                    )}

                    {/* Burndown & ETA row */}
                    {bd && (bd.relatedCompleted > 0 || bd.relatedRemaining > 0) && (
                      <div className="mt-2 flex items-center gap-4 flex-wrap">
                        {/* Sparkline */}
                        {bd.burndown.length >= 2 && (
                          <BurndownSparkline points={bd.burndown} />
                        )}

                        {/* Task counts */}
                        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                          <TrendingUp className="h-3 w-3" />
                          <span>
                            {bd.relatedCompleted} done
                            {bd.relatedRemaining > 0 && `, ${bd.relatedRemaining} remaining`}
                          </span>
                        </div>

                        {/* Velocity */}
                        {bd.velocityPerDay !== null && (
                          <span className="text-[11px] text-zinc-600">
                            {bd.velocityPerDay}/day
                          </span>
                        )}

                        {/* ETA badge */}
                        {eta && (
                          <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                            eta === "Done"
                              ? "bg-emerald-500/10 text-emerald-400"
                              : "bg-blue-500/10 text-blue-400"
                          }`}>
                            <Clock className="h-3 w-3" />
                            ETA: {eta}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
