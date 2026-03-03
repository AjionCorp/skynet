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
  Play,
  Pause,
  Square,
  Pencil,
  Plus,
  Save,
  X,
  Trash2,
  Star,
  Users,
  Wand2,
  Bot,
  Activity,
  TrendingUp,
  Clock,
} from "lucide-react";
import type { MissionStatus, MissionProgress, MissionSummary, MissionConfig, LlmConfig, MissionTracking } from "../types";
import { useSkynet } from "./SkynetProvider";
import { MissionCreator } from "./MissionCreator";

export interface MissionDashboardProps {
  /** Poll interval in milliseconds. Defaults to 30000 (30s). */
  pollInterval?: number;
}

const MISSION_TEMPLATE = `# Mission

## Purpose
Describe the mission purpose here.

## Goals
- [ ] Goal 1
- [ ] Goal 2

## Success Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Current Focus
What the team is currently focused on.
`;

const WORKER_NAMES = [
  "dev-worker-1",
  "dev-worker-2",
  "dev-worker-3",
  "dev-worker-4",
  "task-fixer-1",
  "task-fixer-2",
  "task-fixer-3",
];

const LLM_PROVIDERS: { value: LlmConfig["provider"]; label: string; color: string }[] = [
  { value: "auto", label: "Auto", color: "text-zinc-400 bg-zinc-500/10 border-zinc-500/20" },
  { value: "claude", label: "Claude", color: "text-violet-400 bg-violet-500/10 border-violet-500/20" },
  { value: "codex", label: "Codex", color: "text-green-400 bg-green-500/10 border-green-500/20" },
  { value: "gemini", label: "Gemini", color: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
];

const getProviderBadge = (provider?: LlmConfig["provider"]) => {
  const p = LLM_PROVIDERS.find((lp) => lp.value === provider) ?? LLM_PROVIDERS[0];
  return p;
};

const statusBadge: Record<MissionProgress["status"], { label: string; classes: string }> = {
  met: { label: "Met", classes: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  partial: { label: "Partial", classes: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  "not-met": { label: "Not Met", classes: "bg-red-500/10 text-red-400 border-red-500/20" },
};

export function MissionDashboard({ pollInterval = 30_000 }: MissionDashboardProps = {}) {
  const { apiPrefix } = useSkynet();

  // Multi-mission state
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [missionConfig, setMissionConfig] = useState<MissionConfig>({ activeMission: "main", assignments: {} });
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  // Selected mission detail state
  const [mission, setMission] = useState<MissionStatus | null>(null);
  const [missionProgress, setMissionProgress] = useState<MissionProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pipeline controls
  const [pipelinePaused, setPipelinePaused] = useState(false);
  const [controlLoading, setControlLoading] = useState(false);

  // Editor state
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  // Create new mission state
  const [creating, setCreating] = useState(false);
  const [newMissionName, setNewMissionName] = useState("");

  // Worker assignment state
  const [localAssignments, setLocalAssignments] = useState<Record<string, string | null>>({});
  const [assignmentsDirty, setAssignmentsDirty] = useState(false);

  // LLM config state
  const [localLlmConfigs, setLocalLlmConfigs] = useState<Record<string, LlmConfig>>({});
  const [llmConfigDirty, setLlmConfigDirty] = useState(false);

  // Rename state
  const [renamingSlug, setRenamingSlug] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Mission tracking state
  const [tracking, setTracking] = useState<MissionTracking | null>(null);

  // AI Creator state
  const [showCreator, setShowCreator] = useState(false);

  // Fetch mission list
  const fetchMissions = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/missions`);
      const json = await res.json();
      if (json.data) {
        setMissions(json.data.missions);
        setMissionConfig(json.data.config);
        setLocalAssignments(json.data.config.assignments);
        setAssignmentsDirty(false);
        setLocalLlmConfigs(json.data.config.llmConfigs ?? {});
        setLlmConfigDirty(false);
        // Auto-select the active mission if nothing selected
        if (!selectedSlug && json.data.config.activeMission) {
          setSelectedSlug(json.data.config.activeMission);
        }
      }
    } catch {
      // Non-fatal — we still show whatever we have
    }
  }, [apiPrefix, selectedSlug]);

  // Fetch selected mission detail
  const fetchMissionDetail = useCallback(async () => {
    if (!selectedSlug) return;
    try {
      const slugParam = `?slug=${encodeURIComponent(selectedSlug)}`;
      const [statusRes, pipelineRes, trackingRes] = await Promise.all([
        fetch(`${apiPrefix}/mission/status${slugParam}`),
        fetch(`${apiPrefix}/pipeline/status${slugParam}`),
        fetch(`${apiPrefix}/mission/tracking${slugParam}`),
      ]);
      const statusJson = await statusRes.json();
      const pipelineJson = await pipelineRes.json();
      const trackingJson = await trackingRes.json();

      if (statusJson.error) {
        setError(statusJson.error);
      } else {
        setMission(statusJson.data);
        setError(null);
      }

      if (pipelineJson.data?.missionProgress) {
        setMissionProgress(pipelineJson.data.missionProgress);
      }
      if (pipelineJson.data != null) {
        setPipelinePaused(!!pipelineJson.data.pipelinePaused);
      }

      if (trackingJson.data) {
        setTracking(trackingJson.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch mission");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix, selectedSlug]);

  // Combined fetch
  const fetchAll = useCallback(async () => {
    await Promise.all([fetchMissions(), fetchMissionDetail()]);
  }, [fetchMissions, fetchMissionDetail]);

  const handlePipelineControl = useCallback(async (action: "pause" | "resume" | "start" | "stop") => {
    setControlLoading(true);
    try {
      await fetch(`${apiPrefix}/pipeline/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await fetchAll();
    } catch {
      setError(`Failed to ${action} pipeline`);
    } finally {
      setControlLoading(false);
    }
  }, [apiPrefix, fetchAll]);

  // Edit existing mission
  const startEditing = useCallback(() => {
    setEditContent(mission?.raw ?? MISSION_TEMPLATE);
    setEditing(true);
  }, [mission]);

  const saveMission = useCallback(async () => {
    if (!selectedSlug) return;
    setSaving(true);
    try {
      const res = await fetch(`${apiPrefix}/missions/${selectedSlug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: editContent }),
      });
      const json = await res.json();
      if (json.error) {
        setError(json.error);
      } else {
        setEditing(false);
        await fetchAll();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save mission");
    } finally {
      setSaving(false);
    }
  }, [apiPrefix, selectedSlug, editContent, fetchAll]);

  // Create new mission
  const createMission = useCallback(async () => {
    if (!newMissionName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`${apiPrefix}/missions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newMissionName }),
      });
      const json = await res.json();
      if (json.error) {
        setError(json.error);
      } else {
        setCreating(false);
        setNewMissionName("");
        setSelectedSlug(json.data.slug);
        await fetchMissions();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create mission");
    } finally {
      setSaving(false);
    }
  }, [apiPrefix, newMissionName, fetchMissions]);

  // Delete mission
  const deleteMission = useCallback(async (slug: string) => {
    if (!confirm(`Delete mission "${slug}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${apiPrefix}/missions/${slug}`, { method: "DELETE" });
      const json = await res.json();
      if (json.error) {
        setError(json.error);
      } else {
        if (selectedSlug === slug) setSelectedSlug(missionConfig.activeMission);
        await fetchMissions();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete mission");
    }
  }, [apiPrefix, selectedSlug, missionConfig.activeMission, fetchMissions]);

  // Set active mission
  const setActiveMission = useCallback(async (slug: string) => {
    try {
      const res = await fetch(`${apiPrefix}/missions/assignments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeMission: slug }),
      });
      const json = await res.json();
      if (json.error) setError(json.error);
      else await fetchMissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set active mission");
    }
  }, [apiPrefix, fetchMissions]);

  // Save worker assignments
  const saveAssignments = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/missions/assignments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments: localAssignments }),
      });
      const json = await res.json();
      if (json.error) setError(json.error);
      else {
        setAssignmentsDirty(false);
        await fetchMissions();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save assignments");
    }
  }, [apiPrefix, localAssignments, fetchMissions]);

  // Save LLM config for a mission
  const saveLlmConfig = useCallback(async (slug: string, config: LlmConfig) => {
    try {
      const res = await fetch(`${apiPrefix}/missions/assignments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llmConfigs: { [slug]: config } }),
      });
      const json = await res.json();
      if (json.error) setError(json.error);
      else {
        setLlmConfigDirty(false);
        await fetchMissions();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save LLM config");
    }
  }, [apiPrefix, fetchMissions]);

  // Rename mission — updates the # heading inside the markdown file
  const renameMission = useCallback(async (slug: string, newName: string) => {
    if (!newName.trim()) { setRenamingSlug(null); return; }
    try {
      // Fetch current raw content
      const detailRes = await fetch(`${apiPrefix}/missions/${slug}`);
      const detailJson = await detailRes.json();
      if (detailJson.error || !detailJson.data?.raw) {
        setError(detailJson.error || "Failed to read mission for rename");
        setRenamingSlug(null);
        return;
      }
      const raw: string = detailJson.data.raw;
      // Replace the first # heading, or prepend one if missing
      const updated = raw.match(/^#\s+.+/m)
        ? raw.replace(/^#\s+.+/m, `# ${newName.trim()}`)
        : `# ${newName.trim()}\n\n${raw}`;
      const res = await fetch(`${apiPrefix}/missions/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: updated }),
      });
      const json = await res.json();
      if (json.error) setError(json.error);
      else await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename mission");
    } finally {
      setRenamingSlug(null);
    }
  }, [apiPrefix, fetchAll]);

  // Apply AI-generated mission
  const handleApplyAIMission = useCallback(async (content: string) => {
    if (!selectedSlug) return;
    setSaving(true);
    try {
      const res = await fetch(`${apiPrefix}/missions/${selectedSlug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: content }),
      });
      const json = await res.json();
      if (json.error) {
        setError(json.error);
      } else {
        setShowCreator(false);
        await fetchAll();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply AI mission");
    } finally {
      setSaving(false);
    }
  }, [apiPrefix, selectedSlug, fetchAll]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, pollInterval);
    return () => clearInterval(interval);
  }, [fetchAll, pollInterval]);

  // Re-fetch detail when selected mission changes
  useEffect(() => {
    if (selectedSlug) {
      setLoading(true);
      fetchMissionDetail();
    }
  }, [selectedSlug, fetchMissionDetail]);

  if (loading && missions.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        <span className="ml-3 text-sm text-zinc-500">Loading missions...</span>
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
      {/* Mission selector cards */}
      <div className="flex items-start gap-3 overflow-x-auto pb-2">
        {missions.map((m) => (
          <button
            key={m.slug}
            onClick={() => { setSelectedSlug(m.slug); setEditing(false); }}
            className={`flex min-w-[180px] flex-col gap-1.5 rounded-xl border p-4 text-left transition ${
              selectedSlug === m.slug
                ? "border-cyan-500/40 bg-cyan-500/10"
                : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700"
            }`}
          >
            <div className="flex items-center gap-2">
              {renamingSlug === m.slug ? (
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") renameMission(m.slug, renameValue);
                    if (e.key === "Escape") setRenamingSlug(null);
                  }}
                  onBlur={() => renameMission(m.slug, renameValue)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full rounded border border-cyan-500/50 bg-zinc-950 px-1.5 py-0.5 text-sm font-medium text-white focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                  autoFocus
                />
              ) : (
                <span
                  className="truncate text-sm font-medium text-white"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenamingSlug(m.slug);
                    setRenameValue(m.name);
                  }}
                  title="Double-click to rename"
                >
                  {m.name}
                </span>
              )}
              {m.isActive && (
                <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
              )}
            </div>
            <div className="flex items-center gap-2">
              {m.assignedWorkers.length > 0 && (
                <div className="flex items-center gap-1 text-xs text-zinc-500">
                  <Users className="h-3 w-3" />
                  {m.assignedWorkers.length}
                </div>
              )}
              {(() => {
                const badge = getProviderBadge(m.llmConfig?.provider);
                return (
                  <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${badge.color}`}>
                    <Bot className="h-2.5 w-2.5" />
                    {badge.label}
                  </span>
                );
              })()}
            </div>
          </button>
        ))}
        <button
          onClick={() => setCreating(true)}
          className="flex min-w-[140px] items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 bg-zinc-900/30 p-4 text-sm text-zinc-500 transition hover:border-zinc-600 hover:text-zinc-400"
        >
          <Plus className="h-4 w-4" />
          New Mission
        </button>
      </div>

      {/* Create mission form */}
      {creating && (
        <div className="rounded-xl border border-cyan-500/20 bg-zinc-900/50 p-6">
          <div className="mb-4 flex items-center gap-2">
            <Plus className="h-4 w-4 text-cyan-400" />
            <h2 className="text-lg font-semibold text-white">Create New Mission</h2>
          </div>
          <div className="flex gap-3">
            <input
              value={newMissionName}
              onChange={(e) => setNewMissionName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createMission()}
              placeholder="Mission name..."
              className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2 text-sm text-zinc-300 placeholder-zinc-600 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
              autoFocus
            />
            <button
              onClick={createMission}
              disabled={saving || !newMissionName.trim()}
              className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-400 transition hover:border-cyan-500/50 hover:bg-cyan-500/20 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Create
            </button>
            <button
              onClick={() => { setCreating(false); setNewMissionName(""); }}
              className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-6 py-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Pipeline controls + mission actions + Refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {pipelinePaused ? (
            <button
              onClick={() => handlePipelineControl("resume")}
              disabled={controlLoading}
              className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-400 transition hover:border-emerald-500/50 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </button>
          ) : (
            <button
              onClick={() => handlePipelineControl("pause")}
              disabled={controlLoading}
              className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-400 transition hover:border-amber-500/50 hover:bg-amber-500/20 disabled:opacity-50"
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </button>
          )}
          <button
            onClick={() => handlePipelineControl("start")}
            disabled={controlLoading}
            className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-400 transition hover:border-cyan-500/50 hover:bg-cyan-500/20 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            Start
          </button>
          <button
            onClick={() => handlePipelineControl("stop")}
            disabled={controlLoading}
            className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-400 transition hover:border-red-500/50 hover:bg-red-500/20 disabled:opacity-50"
          >
            <Square className="h-3.5 w-3.5" />
            Stop
          </button>
          {pipelinePaused && (
            <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400">
              <Pause className="h-3 w-3" />
              Pipeline Paused
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {selectedSlug && !missions.find((m) => m.slug === selectedSlug)?.isActive && (
            <>
              <button
                onClick={() => setActiveMission(selectedSlug)}
                className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-400 transition hover:border-amber-500/50 hover:bg-amber-500/20"
              >
                <Star className="h-3 w-3" />
                Set Active
              </button>
              <button
                onClick={() => deleteMission(selectedSlug)}
                className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition hover:border-red-500/50 hover:bg-red-500/20"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            </>
          )}
          <button
            onClick={fetchAll}
            className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-400 transition hover:border-zinc-700 hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Mission Tracking Status */}
      {selectedSlug && tracking && tracking.trackingStatus !== "no-mission" && (
        <div className={`rounded-xl border p-5 ${
          tracking.trackingStatus === "on-track"
            ? "border-emerald-500/20 bg-emerald-500/5"
            : tracking.trackingStatus === "stalled"
              ? "border-red-500/20 bg-red-500/5"
              : tracking.trackingStatus === "idle"
                ? "border-amber-500/20 bg-amber-500/5"
                : "border-zinc-800 bg-zinc-900/50"
        }`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Activity className={`h-5 w-5 ${
                tracking.trackingStatus === "on-track" ? "text-emerald-400" :
                tracking.trackingStatus === "stalled" ? "text-red-400" :
                tracking.trackingStatus === "idle" ? "text-amber-400" :
                "text-zinc-500"
              }`} />
              <div>
                <h2 className="text-sm font-semibold text-white">Mission Tracking</h2>
                <p className={`text-xs ${
                  tracking.trackingStatus === "on-track" ? "text-emerald-400" :
                  tracking.trackingStatus === "stalled" ? "text-red-400" :
                  tracking.trackingStatus === "idle" ? "text-amber-400" :
                  "text-zinc-500"
                }`}>{tracking.trackingMessage}</p>
              </div>
            </div>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider ${
              tracking.trackingStatus === "on-track"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                : tracking.trackingStatus === "stalled"
                  ? "border-red-500/30 bg-red-500/10 text-red-400"
                  : tracking.trackingStatus === "idle"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                    : "border-zinc-700 bg-zinc-800 text-zinc-400"
            }`}>
              {tracking.trackingStatus === "on-track" && <TrendingUp className="h-3 w-3" />}
              {tracking.trackingStatus === "stalled" && <Clock className="h-3 w-3" />}
              {tracking.trackingStatus === "idle" && <Pause className="h-3 w-3" />}
              {tracking.trackingStatus === "no-workers" && <Users className="h-3 w-3" />}
              {tracking.trackingStatus.replace("-", " ")}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            <div className="rounded-lg border border-zinc-800/50 bg-zinc-900/50 px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Workers</p>
              <p className="text-lg font-bold text-white">
                {tracking.activeWorkers}<span className="text-xs font-normal text-zinc-500">/{tracking.assignedWorkers}</span>
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800/50 bg-zinc-900/50 px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Backlog</p>
              <p className="text-lg font-bold text-white">{tracking.backlogCount}</p>
            </div>
            <div className="rounded-lg border border-zinc-800/50 bg-zinc-900/50 px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">In Progress</p>
              <p className="text-lg font-bold text-white">{tracking.inProgressCount}</p>
            </div>
            <div className="rounded-lg border border-zinc-800/50 bg-zinc-900/50 px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Completed</p>
              <p className="text-lg font-bold text-white">{tracking.completedCount}</p>
            </div>
            <div className="rounded-lg border border-zinc-800/50 bg-zinc-900/50 px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Last 24h</p>
              <p className={`text-lg font-bold ${tracking.completedLast24h > 0 ? "text-emerald-400" : "text-zinc-500"}`}>
                {tracking.completedLast24h}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800/50 bg-zinc-900/50 px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Failed</p>
              <p className={`text-lg font-bold ${tracking.failedPendingCount > 0 ? "text-red-400" : "text-zinc-500"}`}>
                {tracking.failedPendingCount}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Progress overview cards */}
      {selectedSlug && mission && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Mission Progress</p>
            <p className="mt-1 text-2xl font-bold text-white">{percentage}%</p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  percentage === 100 ? "bg-emerald-500" : percentage >= 50 ? "bg-cyan-500" : "bg-amber-500"
                }`}
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Success Criteria</p>
            <p className="mt-1 text-2xl font-bold text-white">
              {completedCriteria}<span className="text-sm font-normal text-zinc-500"> / {totalCriteria}</span>
            </p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Goals</p>
            <p className="mt-1 text-2xl font-bold text-white">
              {completedGoals}<span className="text-sm font-normal text-zinc-500"> / {totalGoals}</span>
            </p>
          </div>
          <div className={`rounded-xl border p-4 ${percentage === 100 ? "border-emerald-500/20 bg-emerald-500/5" : "border-zinc-800 bg-zinc-900/50"}`}>
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Status</p>
            <p className={`mt-1 text-2xl font-bold ${percentage === 100 ? "text-emerald-400" : "text-white"}`}>
              {percentage === 100 ? "Complete" : "In Progress"}
            </p>
          </div>
        </div>
      )}

      {/* AI Mission Creator */}
      {showCreator && selectedSlug && (
        <MissionCreator
          currentMission={mission?.raw ?? ""}
          onApply={handleApplyAIMission}
          onClose={() => setShowCreator(false)}
        />
      )}

      {/* Editor */}
      {editing && !showCreator && (
        <div className="rounded-xl border border-cyan-500/20 bg-zinc-900/50 p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-cyan-400" />
              <h2 className="text-lg font-semibold text-white">Edit Mission</h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setEditing(false)}
                disabled={saving}
                className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-white disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </button>
              <button
                onClick={saveMission}
                disabled={saving}
                className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-400 transition hover:border-cyan-500/50 hover:bg-cyan-500/20 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="h-96 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-sm leading-relaxed text-zinc-300 placeholder-zinc-600 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            placeholder="# Mission&#10;&#10;## Purpose&#10;..."
          />
        </div>
      )}

      {/* Mission detail content */}
      {!editing && !showCreator && selectedSlug && mission?.raw && (
        <>
          {/* Raw mission.md content */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-cyan-400" />
                <h2 className="text-lg font-semibold text-white">Mission Document</h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setShowCreator(true); setEditing(false); }}
                  className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-400 transition hover:border-violet-500/50 hover:bg-violet-500/20"
                >
                  <Wand2 className="h-3 w-3" />
                  AI Creator
                </button>
                <button
                  onClick={startEditing}
                  className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-white"
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </button>
              </div>
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
                <span className="ml-auto text-xs text-zinc-500">{completedCriteria} of {totalCriteria} met</span>
              </div>
              <div className="space-y-2">
                {mission.successCriteria.map((criterion, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
                      criterion.completed ? "border-emerald-500/20 bg-emerald-500/5" : "border-zinc-800 bg-zinc-900"
                    }`}
                  >
                    {criterion.completed ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
                    )}
                    <span className={`text-sm ${criterion.completed ? "text-emerald-300" : "text-zinc-300"}`}>
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
                <span className="ml-auto text-xs text-zinc-500">{completedGoals} of {totalGoals} achieved</span>
              </div>
              <div className="space-y-2">
                {mission.goals.map((goal, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
                      goal.completed ? "border-emerald-500/20 bg-emerald-500/5" : "border-zinc-800 bg-zinc-900"
                    }`}
                  >
                    {goal.completed ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
                    )}
                    <span className={`text-sm ${goal.completed ? "text-emerald-300" : "text-zinc-300"}`}>
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

      {/* Worker Assignment Panel */}
      {selectedSlug && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-cyan-400" />
              <h2 className="text-lg font-semibold text-white">Worker Assignments</h2>
            </div>
            {assignmentsDirty && (
              <button
                onClick={saveAssignments}
                className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-400 transition hover:border-cyan-500/50 hover:bg-cyan-500/20"
              >
                <Save className="h-3.5 w-3.5" />
                Save Assignments
              </button>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {WORKER_NAMES.map((worker) => (
              <div key={worker} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                <span className="text-sm font-medium text-zinc-300">{worker}</span>
                <select
                  value={localAssignments[worker] ?? ""}
                  onChange={(e) => {
                    setLocalAssignments((prev) => ({
                      ...prev,
                      [worker]: e.target.value || null,
                    }));
                    setAssignmentsDirty(true);
                  }}
                  className="ml-auto rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 focus:border-cyan-500/50 focus:outline-none"
                >
                  <option value="">Unassigned</option>
                  {missions.map((m) => (
                    <option key={m.slug} value={m.slug}>{m.name}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LLM Configuration Panel */}
      {selectedSlug && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-cyan-400" />
              <h2 className="text-lg font-semibold text-white">LLM Configuration</h2>
            </div>
            {llmConfigDirty && (
              <button
                onClick={() => saveLlmConfig(selectedSlug, localLlmConfigs[selectedSlug] ?? { provider: "auto" })}
                className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-400 transition hover:border-cyan-500/50 hover:bg-cyan-500/20"
              >
                <Save className="h-3.5 w-3.5" />
                Save LLM Config
              </button>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium uppercase tracking-wider text-zinc-500">Provider</label>
              <select
                value={localLlmConfigs[selectedSlug]?.provider ?? "auto"}
                onChange={(e) => {
                  const provider = e.target.value as LlmConfig["provider"];
                  setLocalLlmConfigs((prev) => ({
                    ...prev,
                    [selectedSlug]: { ...prev[selectedSlug], provider, model: undefined },
                  }));
                  setLlmConfigDirty(true);
                }}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 focus:border-cyan-500/50 focus:outline-none"
              >
                {LLM_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-xs font-medium uppercase tracking-wider text-zinc-500">Model (optional)</label>
              <input
                value={localLlmConfigs[selectedSlug]?.model ?? ""}
                onChange={(e) => {
                  setLocalLlmConfigs((prev) => ({
                    ...prev,
                    [selectedSlug]: {
                      ...prev[selectedSlug],
                      provider: prev[selectedSlug]?.provider ?? "auto",
                      model: e.target.value || undefined,
                    },
                  }));
                  setLlmConfigDirty(true);
                }}
                placeholder="e.g. claude-sonnet-4-6"
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 focus:border-cyan-500/50 focus:outline-none"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
