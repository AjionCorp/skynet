"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Minus, Plus, Users } from "lucide-react";
import type { WorkerScaleInfo } from "../types";
import { useSkynet } from "./SkynetProvider";

export interface WorkerScalingProps {
  /** Override the polling interval in ms (default 15000) */
  pollInterval?: number;
}

export function WorkerScaling({ pollInterval = 15000 }: WorkerScalingProps) {
  const { apiPrefix } = useSkynet();
  const [workers, setWorkers] = useState<WorkerScaleInfo[]>([]);
  const [scaling, setScaling] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchCounts = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/workers/scale`);
      const json = await res.json();
      if (json.data) {
        setWorkers(json.data.workers);
        setError(null);
      } else if (json.error) {
        setError(json.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchCounts();
    const interval = setInterval(fetchCounts, pollInterval);
    return () => clearInterval(interval);
  }, [fetchCounts, pollInterval]);

  const scale = useCallback(
    async (workerType: string, newCount: number) => {
      setScaling((p) => ({ ...p, [workerType]: true }));
      setError(null);
      try {
        const res = await fetch(`${apiPrefix}/workers/scale`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workerType, count: newCount }),
        });
        const json = await res.json();
        if (json.error) {
          setError(json.error);
        } else {
          await fetchCounts();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to scale");
      } finally {
        setScaling((p) => ({ ...p, [workerType]: false }));
      }
    },
    [apiPrefix, fetchCounts]
  );

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
        <Users className="h-4 w-4 text-cyan-400" />
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Scale Workers
        </p>
      </div>

      {error && (
        <div className="mb-3 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {workers.map((w) => (
          <div
            key={w.type}
            className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-4 py-3"
          >
            <div>
              <span className="text-sm font-medium text-zinc-300">
                {w.label}
              </span>
              <span className="ml-2 text-xs text-zinc-600">
                {w.count} / {w.maxCount}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => scale(w.type, w.count - 1)}
                disabled={w.count <= 0 || !!scaling[w.type]}
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400 transition hover:border-red-500/50 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {scaling[w.type] ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Minus className="h-3.5 w-3.5" />
                )}
              </button>
              <span className="w-6 text-center text-sm font-bold text-white">
                {w.count}
              </span>
              <button
                onClick={() => scale(w.type, w.count + 1)}
                disabled={w.count >= w.maxCount || !!scaling[w.type]}
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400 transition hover:border-emerald-500/50 hover:text-emerald-400 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {scaling[w.type] ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
