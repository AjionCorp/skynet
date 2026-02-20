"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ScrollText, RefreshCw } from "lucide-react";
import type { LogData } from "../types";
import { useSkynet } from "./SkynetProvider";

function getLogSources(maxWorkers: number, maxFixers: number) {
  const sources: { value: string; label: string }[] = [];
  for (let i = 1; i <= maxWorkers; i++) {
    sources.push({ value: `dev-worker-${i}`, label: `Worker ${i}` });
  }
  for (let i = 1; i <= maxFixers; i++) {
    sources.push({
      value: i === 1 ? "task-fixer" : `task-fixer-${i}`,
      label: `Fixer ${i}`,
    });
  }
  sources.push(
    { value: "watchdog", label: "Watchdog" },
    { value: "health-check", label: "Health Check" },
    { value: "project-driver", label: "Project Driver" },
  );
  return sources;
}

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_MAX_FIXERS = 3;

export interface LogViewerProps {
  /** Default log source to select on mount */
  defaultSource?: string;
  /** Number of log lines to fetch (default 200) */
  lineCount?: number;
}

export function LogViewer({
  defaultSource = "dev-worker-1",
  lineCount = 200,
}: LogViewerProps) {
  const { apiPrefix } = useSkynet();
  const [source, setSource] = useState(defaultSource);
  const [logSources, setLogSources] = useState(() =>
    getLogSources(DEFAULT_MAX_WORKERS, DEFAULT_MAX_FIXERS),
  );
  const [logData, setLogData] = useState<LogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  // Fetch worker/fixer counts from config API
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiPrefix}/config`);
        const json = await res.json();
        if (cancelled) return;
        const entries: { key: string; value: string }[] =
          json.data?.entries ?? [];
        let maxWorkers = DEFAULT_MAX_WORKERS;
        let maxFixers = DEFAULT_MAX_FIXERS;
        for (const entry of entries) {
          if (entry.key === "SKYNET_MAX_WORKERS") {
            const n = Number(entry.value);
            if (Number.isInteger(n) && n >= 1) maxWorkers = n;
          }
          if (entry.key === "SKYNET_MAX_FIXERS") {
            const n = Number(entry.value);
            if (Number.isInteger(n) && n >= 1) maxFixers = n;
          }
        }
        setLogSources(getLogSources(maxWorkers, maxFixers));
      } catch {
        // Keep defaults on failure
      }
    })();
    return () => { cancelled = true; };
  }, [apiPrefix]);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(
        `${apiPrefix}/monitoring/logs?script=${encodeURIComponent(source)}&lines=${lineCount}`
      );
      const json = await res.json();
      if (json.data) {
        setLogData(json.data);
        setError(null);
      } else if (json.error) {
        setError(json.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch logs");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix, source, lineCount]);

  // Fetch on mount and when source changes
  useEffect(() => {
    setLoading(true);
    fetchLogs();
  }, [fetchLogs]);

  // Auto-refresh polling (5s)
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  // Auto-scroll to bottom when log data updates
  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [logData]);

  const handleSourceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSource(e.target.value);
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <ScrollText className="h-4 w-4 text-cyan-400" />
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Log Viewer
        </p>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 mb-4">
        <select
          value={source}
          onChange={handleSourceChange}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 outline-none focus:border-cyan-500/50"
        >
          {logSources.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <button
          onClick={() => setAutoRefresh((prev) => !prev)}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
            autoRefresh
              ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-400"
              : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600"
          }`}
        >
          <RefreshCw
            className={`h-3 w-3 ${autoRefresh ? "animate-spin" : ""}`}
          />
          Auto-refresh {autoRefresh ? "ON" : "OFF"}
        </button>

        <button
          onClick={fetchLogs}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 disabled:opacity-30"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>

        {logData && (
          <span className="ml-auto text-xs text-zinc-600">
            {logData.totalLines.toLocaleString()} total lines &middot;{" "}
            {(logData.fileSizeBytes / 1024).toFixed(1)} KB
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-3 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Log content */}
      {loading && !logData ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
        </div>
      ) : (
        <pre
          ref={preRef}
          className="max-h-[600px] overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-400"
        >
          {logData?.lines.length
            ? logData.lines.join("\n")
            : "No log data available"}
        </pre>
      )}
    </div>
  );
}
