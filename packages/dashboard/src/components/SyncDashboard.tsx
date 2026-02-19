"use client";

import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  AlertTriangle,
  Database,
} from "lucide-react";
import type { SyncStatus } from "../types.js";
import { useSkynet } from "./SkynetProvider.js";

// ===== Helpers =====

function getStatusBadge(status: SyncStatus["status"] | undefined) {
  switch (status) {
    case "success":
      return {
        icon: CheckCircle2,
        label: "Success",
        className:
          "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25",
      };
    case "syncing":
      return {
        icon: Loader2,
        label: "Syncing",
        className: "bg-amber-500/15 text-amber-400 border border-amber-500/25",
      };
    case "error":
      return {
        icon: XCircle,
        label: "Error",
        className: "bg-red-500/15 text-red-400 border border-red-500/25",
      };
    case "pending":
      return {
        icon: Clock,
        label: "Pending",
        className: "bg-zinc-700/40 text-zinc-400 border border-zinc-600/25",
      };
    default:
      return {
        icon: Clock,
        label: "Never Run",
        className: "bg-zinc-700/40 text-zinc-500 border border-zinc-600/25",
      };
  }
}

function formatLastSynced(dateStr: string | null): string {
  if (!dateStr) return "Never";
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffDays = Math.floor(diffMs / 86_400_000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function formatRecordCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return n.toLocaleString();
  return String(n);
}

// ===== Types =====

interface SyncEndpointDef {
  apiName: string;
  label: string;
  description: string;
}

export interface SyncDashboardProps {
  /** Define the sync endpoints to display. Each must have an apiName matching the sync-health data. */
  endpoints?: SyncEndpointDef[];
}

// ===== Component =====

export function SyncDashboard({ endpoints }: SyncDashboardProps = {}) {
  const { apiPrefix } = useSkynet();

  const [statusMap, setStatusMap] = useState<Record<string, SyncStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch sync health from pipeline status endpoint (file-based sync-health.md data)
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/pipeline/status`);
      const json = await res.json();

      if (json.error) {
        setError(json.error);
        return;
      }

      // Map syncHealth array from pipeline status to SyncStatus records
      const data = json.data;
      const map: Record<string, SyncStatus> = {};

      if (data?.syncHealth && Array.isArray(data.syncHealth)) {
        for (const entry of data.syncHealth) {
          const apiName = entry.endpoint?.toLowerCase().replace(/\s+/g, "_") ?? "";
          map[apiName] = {
            api_name: apiName,
            status: entry.status === "ok" ? "success" : entry.status === "error" ? "error" : "pending",
            last_synced: entry.lastRun || null,
            records_count: entry.records ? parseInt(entry.records.replace(/[^\d]/g, ""), 10) || null : null,
            error_message: entry.status === "error" ? (entry.notes || "Sync error") : null,
          };
        }
      }

      setStatusMap(map);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch status");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // If endpoints prop is provided, use those; otherwise derive from statusMap
  const displayEndpoints: SyncEndpointDef[] = endpoints ?? Object.keys(statusMap).map((key) => ({
    apiName: key,
    label: key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: "",
  }));

  // Summary counts
  const totalEndpoints = displayEndpoints.length;
  const successCount = displayEndpoints.filter(
    (ep) => statusMap[ep.apiName]?.status === "success"
  ).length;
  const errorCount = displayEndpoints.filter(
    (ep) => statusMap[ep.apiName]?.status === "error"
  ).length;
  const syncingCount = displayEndpoints.filter(
    (ep) => statusMap[ep.apiName]?.status === "syncing"
  ).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        <span className="ml-3 text-sm text-zinc-500">Loading sync status...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Endpoints
          </p>
          <p className="mt-1 text-2xl font-bold text-white">{totalEndpoints}</p>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-emerald-400">
            Healthy
          </p>
          <p className="mt-1 text-2xl font-bold text-white">{successCount}</p>
        </div>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-red-400">
            Errors
          </p>
          <p className="mt-1 text-2xl font-bold text-white">{errorCount}</p>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-amber-400">
            Syncing
          </p>
          <p className="mt-1 text-2xl font-bold text-white">{syncingCount}</p>
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
          onClick={fetchStatus}
          className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-400 transition hover:border-zinc-700 hover:text-white"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Empty state */}
      {displayEndpoints.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 py-16">
          <Database className="h-8 w-8 text-zinc-600" />
          <p className="mt-3 text-sm font-medium text-zinc-400">No sync endpoints configured</p>
          <p className="mt-1 text-xs text-zinc-600">Add SKYNET_SYNC_ENDPOINTS to your skynet.project.sh</p>
        </div>
      )}

      {/* Sync endpoints table */}
      {displayEndpoints.length > 0 && <div className="overflow-hidden rounded-xl border border-zinc-800">
        {/* Table header */}
        <div className="hidden border-b border-zinc-800 bg-zinc-900/80 px-6 py-3 lg:grid lg:grid-cols-12 lg:gap-4">
          <div className="col-span-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
            Endpoint
          </div>
          <div className="col-span-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
            Status
          </div>
          <div className="col-span-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
            Last Synced
          </div>
          <div className="col-span-4 text-xs font-medium uppercase tracking-wider text-zinc-500">
            Records
          </div>
        </div>

        {/* Table rows */}
        <div className="divide-y divide-zinc-800">
          {displayEndpoints.map((endpoint) => {
            const syncStatus = statusMap[endpoint.apiName];
            const badge = getStatusBadge(syncStatus?.status);
            const BadgeIcon = badge.icon;
            const isSyncing = syncStatus?.status === "syncing";

            return (
              <div
                key={endpoint.apiName}
                className="group bg-zinc-900 px-6 py-4 transition hover:bg-zinc-800/70 lg:grid lg:grid-cols-12 lg:items-center lg:gap-4"
              >
                {/* Endpoint name */}
                <div className="col-span-3">
                  <p className="text-sm font-semibold text-white">
                    {endpoint.label}
                  </p>
                  {endpoint.description && (
                    <p className="text-xs text-zinc-500">
                      {endpoint.description}
                    </p>
                  )}
                </div>

                {/* Status badge */}
                <div className="col-span-2 mt-2 lg:mt-0">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${badge.className}`}
                  >
                    <BadgeIcon
                      className={`h-3 w-3 ${isSyncing ? "animate-spin" : ""}`}
                    />
                    {isSyncing ? "Syncing..." : badge.label}
                  </span>
                </div>

                {/* Last synced */}
                <div className="col-span-3 mt-1 lg:mt-0">
                  <span className="text-sm text-zinc-400">
                    {formatLastSynced(syncStatus?.last_synced ?? null)}
                  </span>
                </div>

                {/* Record count */}
                <div className="col-span-4 mt-1 lg:mt-0">
                  <div className="flex items-center gap-1.5">
                    <Database className="h-3.5 w-3.5 text-zinc-600" />
                    <span className="text-sm font-medium text-zinc-300">
                      {syncStatus?.records_count != null
                        ? formatRecordCount(syncStatus.records_count)
                        : "--"}
                    </span>
                  </div>
                </div>

                {/* Error message row */}
                {syncStatus?.error_message && (
                  <div className="col-span-12 mt-2">
                    <div className="rounded-lg bg-red-500/5 px-3 py-2">
                      <p className="text-xs text-red-400">
                        {syncStatus.error_message}
                      </p>
                    </div>
                  </div>
                )}

                {/* Mobile layout labels */}
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-500 lg:hidden">
                  <span>
                    Records:{" "}
                    {syncStatus?.records_count != null
                      ? formatRecordCount(syncStatus.records_count)
                      : "--"}
                  </span>
                  <span className="text-zinc-700">|</span>
                  <span>
                    Last: {formatLastSynced(syncStatus?.last_synced ?? null)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>}
    </div>
  );
}
