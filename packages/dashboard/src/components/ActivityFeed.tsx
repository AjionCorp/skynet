"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import type { EventEntry } from "../types";
import { useSkynet } from "./SkynetProvider";

function dotColor(event: string): string {
  const e = event.toLowerCase();
  if (e.includes("completed") || e.includes("succeeded")) return "bg-emerald-400";
  if (e.includes("failed")) return "bg-red-400";
  if (e.includes("claimed") || e.includes("started")) return "bg-blue-400";
  if (e.includes("killed") || e.includes("warning")) return "bg-amber-400";
  return "bg-zinc-500";
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ActivityFeed() {
  const { apiPrefix } = useSkynet();
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    const interval = setInterval(fetchEvents, 10000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  return (
    <div className="rounded-xl border border-zinc-800 overflow-hidden">
      <div className="flex items-center gap-2 bg-zinc-900 px-5 py-3">
        <Activity className="h-4 w-4 text-purple-400" />
        <span className="text-sm font-semibold text-white">Activity Feed</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />}
      </div>
      {error && (
        <div className="px-5 py-2 text-xs text-red-400">{error}</div>
      )}
      <div className="max-h-[400px] overflow-y-auto divide-y divide-zinc-800/50">
        {events.length === 0 && !loading ? (
          <p className="px-5 py-3 text-sm text-zinc-500">No events recorded</p>
        ) : (
          [...events].reverse().map((entry, i) => (
            <div key={i} className="flex items-start gap-3 bg-zinc-900/50 px-5 py-2.5">
              <div className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotColor(entry.event)}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-zinc-300">{entry.event}</span>
                  <span className="text-xs text-zinc-600">{formatTimestamp(entry.ts)}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-zinc-500">{entry.detail}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
