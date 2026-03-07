"use client";

import { useEffect, useState } from "react";
import { Target, Users, Activity, Play, Pause, Square, Brain, ShieldCheck } from "lucide-react";
import type { MissionSummary, PipelineStatus, CurrentTask } from "../types";
import { useSkynet } from "./SkynetProvider";

function getWorkerTaskKey(workerName: string): string | null {
  const devWorkerMatch = workerName.match(/^dev-worker-(\d+)$/);
  return devWorkerMatch ? `worker-${devWorkerMatch[1]}` : null;
}

function getFixerId(workerName: string): string | null {
  const fixerMatch = workerName.match(/^task-fixer(?:-(\d+))?$/);
  return fixerMatch ? fixerMatch[1] ?? "1" : null;
}

function getWorkerShortName(workerName: string): string {
  const devWorkerMatch = workerName.match(/^dev-worker-(\d+)$/);
  if (devWorkerMatch) {
    return `W${devWorkerMatch[1]}`;
  }

  const fixerId = getFixerId(workerName);
  if (fixerId) {
    return `F${fixerId}`;
  }

  return workerName;
}

export function MissionSidebar() {
  const { apiPrefix } = useSkynet();
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getStatus = () => {
    if (!pipeline) return { label: "UNKNOWN", color: "text-zinc-500", icon: Activity };
    if (!pipeline.watchdogRunning) return { label: "STOPPED", color: "text-red-500", icon: Square };
    if (pipeline.pipelinePaused) return { label: "PAUSED", color: "text-yellow-500", icon: Pause };
    if (pipeline.projectDriverRunning) return { label: "ANALYZING", color: "text-violet-400", icon: Brain };
    return { label: "WORKING", color: "text-green-500", icon: Play };
  };

  const status = getStatus();

  const getAuthBadge = (name: string, ok: boolean, warning?: boolean) => {
    const color = ok ? "bg-green-500" : warning ? "bg-amber-500" : "bg-red-500";
    return (
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
        <span className="text-[9px] font-bold text-zinc-400 uppercase">{name}</span>
      </div>
    );
  };

  const fetchData = async () => {
    try {
      const [missionsRes, pipelineRes] = await Promise.all([
        fetch(`${apiPrefix}/missions`),
        fetch(`${apiPrefix}/pipeline/status`)
      ]);

      if (!missionsRes.ok || !pipelineRes.ok) {
        throw new Error("Failed to refresh mission intelligence");
      }

      const missionsJson = await missionsRes.json();
      const pipelineJson = await pipelineRes.json();

      if (missionsJson.error) {
        throw new Error(typeof missionsJson.error === "string" ? missionsJson.error : "Failed to load missions");
      }
      if (pipelineJson.error) {
        throw new Error(typeof pipelineJson.error === "string" ? pipelineJson.error : "Failed to load pipeline status");
      }

      if (Array.isArray(missionsJson.data?.missions)) {
        setMissions(missionsJson.data.missions);
      }
      if (pipelineJson.data) {
        setPipeline(pipelineJson.data);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch sidebar data");
      console.error("Failed to fetch sidebar data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [apiPrefix]);

  if (loading && missions.length === 0) {
    return (
      <aside className="w-72 border-r border-zinc-800 bg-zinc-950/40 p-4 hidden lg:block">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-full bg-zinc-800 rounded"></div>
          <div className="h-4 w-24 bg-zinc-800 rounded"></div>
          <div className="space-y-2">
            <div className="h-20 bg-zinc-900 rounded"></div>
            <div className="h-20 bg-zinc-900 rounded"></div>
          </div>
        </div>
      </aside>
    );
  }

  const getWorkerTask = (workerName: string): CurrentTask | null => {
    if (!pipeline) return null;

    const taskKey = getWorkerTaskKey(workerName);
    if (taskKey) {
      return pipeline.currentTasks?.[taskKey] || null;
    }

    const fixerId = getFixerId(workerName);
    if (!fixerId) return null;

    const activeFix = pipeline.failed.find((failedTask) => failedTask.status === `fixing-${fixerId}`);
    if (activeFix) {
      return {
        status: "in_progress",
        title: activeFix.task,
        branch: activeFix.branch || null,
        started: null,
        worker: workerName,
        lastInfo: activeFix.error || null,
      };
    }

    const fixer = pipeline.workers.find((worker) => worker.name === workerName);
    if (fixer?.running) {
      return {
        status: "working",
        title: null,
        branch: null,
        started: null,
        worker: workerName,
        lastInfo: null,
      };
    }

    return {
      status: "idle",
      title: null,
      branch: null,
      started: null,
      worker: workerName,
      lastInfo: null,
    };
  };

  return (
    <aside className="w-72 border-r border-zinc-800 bg-zinc-950/40 overflow-y-auto hidden lg:flex flex-col">
      <div className="p-4 border-b border-zinc-800 sticky top-0 bg-zinc-950/80 backdrop-blur-sm z-10 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-zinc-400">
            <Target className="h-4 w-4 text-cyan-400" />
            <span className="text-xs font-bold uppercase tracking-wider">Mission Intelligence</span>
          </div>
          {error && (
            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
              Stale
            </span>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
            {error}
          </div>
        )}

        {/* Global Pipeline Status */}
        <div className="bg-zinc-900/80 rounded-lg p-3 border border-zinc-800">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">Pipeline State</span>
            {pipeline?.watchdogRunning && (!pipeline?.pipelinePaused || pipeline?.projectDriverRunning) && (
              <span className="flex h-2 w-2">
                <span className={`animate-ping absolute inline-flex h-2 w-2 rounded-full opacity-75 ${pipeline?.projectDriverRunning ? 'bg-violet-400' : 'bg-green-400'}`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${pipeline?.projectDriverRunning ? 'bg-violet-500' : 'bg-green-500'}`}></span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <status.icon className={`h-4 w-4 ${status.color}`} />
            <span className={`text-lg font-black tracking-tight ${status.color}`}>
              {status.label}
            </span>
          </div>
        </div>

        {/* Intelligence Auth State */}
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-1 text-[10px] font-bold text-zinc-500 uppercase tracking-tight">
            <ShieldCheck className="h-3 w-3 text-cyan-500/70" />
            <span>Agent Auth</span>
          </div>
          <div className="flex gap-3">
            {getAuthBadge("Claude", !!pipeline?.auth.tokenCached)}
            {getAuthBadge("Codex", pipeline?.auth.codex.status === "ok" || pipeline?.auth.codex.status === "api_key")}
            {getAuthBadge("Gemini", pipeline?.auth.gemini.status === "ok")}
          </div>
        </div>
      </div>

      <div className="p-2 space-y-1">
        {missions.map((mission) => (
          <div 
            key={mission.slug}
            className={`p-3 rounded-lg transition border ${
              mission.isActive 
                ? "bg-cyan-500/5 border-cyan-500/20" 
                : "border-transparent hover:bg-zinc-900"
            }`}
          >
            <div className="flex items-start justify-between mb-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <h3 className={`text-sm font-semibold truncate ${mission.isActive ? "text-cyan-400" : "text-zinc-200"}`}>
                    {mission.name}
                  </h3>
                  {mission.isActive && (
                    <span className="flex h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  )}
                </div>
                <p className="text-[10px] text-zinc-500 truncate font-mono">
                  {mission.slug}
                </p>
              </div>
              <span className="text-xs font-mono font-bold text-zinc-400">
                {mission.completionPercentage}%
              </span>
            </div>

            {/* Progress Bar */}
            <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden mb-3">
              <div 
                className={`h-full transition-all duration-500 ${
                  mission.isActive ? "bg-cyan-500" : "bg-zinc-600"
                }`}
                style={{ width: `${mission.completionPercentage}%` }}
              />
            </div>

            {/* Active Workers & Tasks */}
            {mission.assignedWorkers.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1 text-[10px] text-zinc-500 font-bold uppercase tracking-tight">
                  <Users className="h-3 w-3" />
                  <span>Assigned: {mission.assignedWorkers.length}</span>
                </div>
                
                <div className="space-y-1.5">
                  {mission.assignedWorkers.map((workerName) => {
                    const task = getWorkerTask(workerName);
                    return (
                      <div key={workerName} className="bg-zinc-900/50 rounded p-2 border border-zinc-800/50">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-mono text-cyan-500/80">
                            {getWorkerShortName(workerName)}
                          </span>
                          {(task?.status === "in_progress" || task?.status === "working") && (
                            <Activity className="h-2.5 w-2.5 text-green-500 animate-pulse" />
                          )}
                        </div>
                        <p className="text-[11px] text-zinc-300 leading-tight line-clamp-2 italic">
                          {task?.title || (task?.status === "idle" ? "Idle" : "Thinking...")}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Global Stats Footer */}
      <div className="mt-auto p-4 border-t border-zinc-800 bg-zinc-900/20">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="block text-[10px] text-zinc-500 uppercase">Health</span>
            <span className={`text-sm font-bold font-mono ${
              (pipeline?.healthScore || 0) > 80 ? "text-green-500" : "text-yellow-500"
            }`}>
              {pipeline?.healthScore ?? "--"}%
            </span>
          </div>
          <div>
            <span className="block text-[10px] text-zinc-500 uppercase">Velocity</span>
            <span className="text-sm font-bold font-mono text-zinc-200">
              {pipeline?.averageTaskDuration ?? "--"}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
