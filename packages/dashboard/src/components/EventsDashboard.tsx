"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Loader2, RefreshCw, Search, Filter } from "lucide-react";
import type { EventEntry } from "../types";
import { useSkynet } from "./SkynetProvider";

function badgeStyle(event: string): { bg: string; text: string; border: string } {
  const e = event.toLowerCase();
  if (e.includes("completed") || e.includes("succeeded"))
    return { bg: "rgba(16,185,129,0.15)", text: "#34d399", border: "rgba(16,185,129,0.25)" };
  if (e.includes("failed"))
    return { bg: "rgba(239,68,68,0.15)", text: "#f87171", border: "rgba(239,68,68,0.25)" };
  if (e.includes("claimed") || e.includes("started"))
    return { bg: "rgba(59,130,246,0.15)", text: "#60a5fa", border: "rgba(59,130,246,0.25)" };
  if (e.includes("killed") || e.includes("warning"))
    return { bg: "rgba(245,158,11,0.15)", text: "#fbbf24", border: "rgba(245,158,11,0.25)" };
  return { bg: "rgba(113,113,122,0.15)", text: "#a1a1aa", border: "rgba(113,113,122,0.25)" };
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export interface EventsDashboardProps {
  /** Polling interval in ms (default 10000) */
  pollInterval?: number;
}

export function EventsDashboard({ pollInterval = 10000 }: EventsDashboardProps) {
  const { apiPrefix } = useSkynet();
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/events`);
      const json = await res.json();
      if (json.error) {
        setError(json.error);
        return;
      }
      setEvents(json.data ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch events");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchEvents();
    const interval = setInterval(fetchEvents, pollInterval);
    return () => clearInterval(interval);
  }, [fetchEvents, pollInterval]);

  const eventTypes = useMemo(() => {
    const types = new Set(events.map((e) => e.event));
    return Array.from(types).sort();
  }, [events]);

  const filtered = useMemo(() => {
    let result = [...events].reverse();
    if (filterType !== "all") {
      result = result.filter((e) => e.event === filterType);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (e) =>
          e.event.toLowerCase().includes(q) ||
          e.detail.toLowerCase().includes(q)
      );
    }
    return result;
  }, [events, filterType, searchQuery]);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between bg-zinc-900 px-5 py-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-purple-400" />
            <span className="text-sm font-semibold text-white">Events</span>
            <span className="text-xs text-zinc-500">({filtered.length})</span>
            {loading && <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />}
          </div>
          <button
            onClick={fetchEvents}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 transition hover:text-white disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900/50 px-5 py-2.5">
          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-zinc-500" />
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-zinc-600"
            >
              <option value="all">All types</option>
              {eventTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5 flex-1">
            <Search className="h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              placeholder="Search events..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-600"
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-5 my-3 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/80 text-zinc-500">
                <th className="px-5 py-2 font-medium">Timestamp</th>
                <th className="px-5 py-2 font-medium">Event Type</th>
                <th className="px-5 py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {filtered.length === 0 && !loading ? (
                <tr>
                  <td colSpan={3} className="px-5 py-8 text-center text-sm text-zinc-500">
                    No events found
                  </td>
                </tr>
              ) : (
                filtered.map((entry, i) => {
                  const badge = badgeStyle(entry.event);
                  return (
                    <tr key={i} className="bg-zinc-900/50 hover:bg-zinc-800/50 transition-colors">
                      <td className="whitespace-nowrap px-5 py-2 text-zinc-400">
                        {formatTimestamp(entry.ts)}
                      </td>
                      <td className="px-5 py-2">
                        <span
                          style={{
                            backgroundColor: badge.bg,
                            color: badge.text,
                            borderColor: badge.border,
                            borderWidth: "1px",
                            borderStyle: "solid",
                            borderRadius: "9999px",
                            padding: "2px 8px",
                            fontSize: "11px",
                            fontWeight: 500,
                          }}
                        >
                          {entry.event}
                        </span>
                      </td>
                      <td className="px-5 py-2 text-zinc-400 max-w-md truncate">
                        {entry.detail}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
