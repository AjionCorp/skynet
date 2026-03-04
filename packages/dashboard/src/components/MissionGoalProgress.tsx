"use client";

import {
  Target,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";
import type { MissionProgress } from "../types";

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

export function MissionGoalProgress({
  missionProgress,
  alignmentScore,
}: MissionGoalProgressProps) {
  const [expanded, setExpanded] = useState(true);

  if (missionProgress.length === 0) return null;

  const metCount = missionProgress.filter((p) => p.status === "met").length;
  const partialCount = missionProgress.filter((p) => p.status === "partial").length;
  const total = missionProgress.length;

  const alignLevel =
    alignmentScore >= 80 ? "emerald" : alignmentScore >= 50 ? "amber" : "red";

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

          {/* Individual criteria */}
          {missionProgress.map((item) => {
            const cfg = statusConfig[item.status];
            const Icon = cfg.icon;
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
