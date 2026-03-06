"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Clock, GitBranch, Loader2, Target } from "lucide-react";
import type { WorkerIntent } from "../types";
import { useSkynet } from "./SkynetProvider";

export interface WorkerIntentsProps {
  pollInterval?: number;
}

const STATUS_COLORS: Record<string, string> = {
  in_progress: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  claimed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  idle: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

function getResponseError(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const error = (json as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error : null;
}

function getIntents(json: unknown): WorkerIntent[] | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const intents = (data as { intents?: unknown }).intents;
  return Array.isArray(intents) ? (intents as WorkerIntent[]) : null;
}

async function readJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function formatAge(ms: number | null): string {
  if (ms == null) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export function WorkerIntents({ pollInterval = 15000 }: WorkerIntentsProps) {
  const { apiPrefix } = useSkynet();
  const [intents, setIntents] = useState<WorkerIntent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchIntents = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/workers/intents`);
      const json = await readJsonSafe(res);
      const intents = getIntents(json);
      const apiError = getResponseError(json);
      if (!res.ok) {
        setError(apiError ?? `Failed to fetch worker intents (HTTP ${res.status})`);
        return;
      }
      if (!intents) {
        setError(apiError ?? "Invalid worker intent response");
        return;
      }
      setIntents(intents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchIntents();
    const interval = setInterval(fetchIntents, pollInterval);
    return () => clearInterval(interval);
  }, [fetchIntents, pollInterval]);

  if (loading) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Target className="h-4 w-4 text-violet-400" />
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Worker Intents
        </p>
        {intents.length > 0 && (
          <span className="ml-auto text-xs text-zinc-600">
            {intents.length} active
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {intents.length === 0 ? (
        <p className="text-xs text-zinc-600 py-2">No active intents</p>
      ) : (
        <div className="space-y-2">
          {intents.map((intent) => {
            const statusClass =
              STATUS_COLORS[intent.status] ?? STATUS_COLORS.idle;
            return (
              <div
                key={intent.workerId}
                className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-4 py-3"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-300">
                      Worker {intent.workerId}
                    </span>
                    <span
                      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs ${statusClass}`}
                    >
                      {intent.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-zinc-600">
                    <Activity className="h-3 w-3" />
                    {formatAge(intent.heartbeatAgeMs)}
                  </div>
                </div>

                {intent.taskTitle && (
                  <p className="text-xs text-zinc-400 mb-1.5">
                    {intent.taskTitle}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                  {intent.branch && (
                    <span className="inline-flex items-center gap-1">
                      <GitBranch className="h-3 w-3" />
                      <code className="text-zinc-400">{intent.branch}</code>
                    </span>
                  )}
                  {intent.startedAt && (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {intent.startedAt}
                    </span>
                  )}
                </div>

                {intent.lastInfo && (
                  <p className="mt-1.5 text-xs text-zinc-600 truncate">
                    {intent.lastInfo}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
