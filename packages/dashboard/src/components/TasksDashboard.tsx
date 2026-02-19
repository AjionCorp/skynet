"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitBranch,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { BacklogItem, TaskBacklogData } from "../types";
import { useSkynet } from "./SkynetProvider";

const DEFAULT_TAG_COLORS: Record<string, string> = {
  FEAT: "bg-cyan-500/15 text-cyan-400 border-cyan-500/25",
  FIX: "bg-red-500/15 text-red-400 border-red-500/25",
  DATA: "bg-violet-500/15 text-violet-400 border-violet-500/25",
  INFRA: "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",
  TEST: "bg-orange-500/15 text-orange-400 border-orange-500/25",
  NMI: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
};

export interface TasksDashboardProps {
  /** Available task tags to show in the tag selector. Defaults to ["FEAT", "FIX", "DATA", "INFRA", "TEST"]. */
  taskTags?: string[];
  /** Tag color overrides. Keys are tag names, values are Tailwind class strings. */
  tagColors?: Record<string, string>;
}

export function TasksDashboard({ taskTags, tagColors }: TasksDashboardProps = {}) {
  const { apiPrefix } = useSkynet();

  const tags = taskTags ?? ["FEAT", "FIX", "DATA", "INFRA", "TEST", "NMI"];
  const mergedTagColors = { ...DEFAULT_TAG_COLORS, ...tagColors };

  const [backlog, setBacklog] = useState<TaskBacklogData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedTag, setSelectedTag] = useState<string>(tags[0] ?? "FEAT");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [blockedByInput, setBlockedByInput] = useState("");
  const [position, setPosition] = useState<"top" | "bottom">("top");
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ ok: boolean; message: string } | null>(null);

  const fetchBacklog = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${apiPrefix}/tasks`);
      const json = await res.json();
      if (json.error) {
        setError(json.error);
      } else {
        setBacklog(json.data);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch backlog");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchBacklog();
  }, [fetchBacklog]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setSubmitResult(null);

    try {
      const res = await fetch(`${apiPrefix}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: selectedTag, title: title.trim(), description: description.trim() || undefined, blockedBy: blockedByInput.trim() || undefined, position }),
      });
      const json = await res.json();
      if (json.error) {
        setSubmitResult({ ok: false, message: json.error });
      } else {
        setSubmitResult({ ok: true, message: `Task added at ${json.data.position} of backlog` });
        setTitle("");
        setDescription("");
        setBlockedByInput("");
        fetchBacklog();
      }
    } catch (err) {
      setSubmitResult({ ok: false, message: err instanceof Error ? err.message : "Failed to add task" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Clock className="h-4 w-4" />
            Pending
          </div>
          <div className="mt-1 text-2xl font-bold text-white">
            {backlog?.pendingCount ?? "\u2014"}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4" />
            Claimed
          </div>
          <div className="mt-1 text-2xl font-bold text-white">
            {backlog?.claimedCount ?? "\u2014"}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <CheckCircle2 className="h-4 w-4" />
            Completed
          </div>
          <div className="mt-1 text-2xl font-bold text-white">
            {backlog?.doneCount ?? "\u2014"}
          </div>
        </div>
      </div>

      {/* Create task form */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Create Task</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Tag selector */}
          <div>
            <label className="mb-2 block text-sm text-zinc-400">Tag</label>
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setSelectedTag(tag)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                    mergedTagColors[tag] ?? "bg-zinc-500/15 text-zinc-400 border-zinc-500/25"
                  } ${
                    selectedTag === tag
                      ? "ring-2 ring-white/20"
                      : "opacity-50 hover:opacity-80"
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div>
            <label htmlFor="task-title" className="mb-2 block text-sm text-zinc-400">
              Title <span className="text-red-400">*</span>
            </label>
            <input
              id="task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Add dark mode toggle to settings page"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label htmlFor="task-desc" className="mb-2 block text-sm text-zinc-400">
              Description <span className="text-zinc-600">(optional)</span>
            </label>
            <input
              id="task-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. add toggle in /profile settings section, persist preference in localStorage"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
            />
          </div>

          {/* Blocked By */}
          <div>
            <label htmlFor="task-blocked-by" className="mb-2 block text-sm text-zinc-400">
              Blocked By <span className="text-zinc-600">(optional, comma-separated task titles)</span>
            </label>
            <input
              id="task-blocked-by"
              type="text"
              value={blockedByInput}
              onChange={(e) => setBlockedByInput(e.target.value)}
              placeholder="e.g. Add database indexes, Set up API endpoint"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
            />
          </div>

          {/* Position toggle */}
          <div>
            <label className="mb-2 block text-sm text-zinc-400">Priority Position</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPosition("top")}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  position === "top"
                    ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-400"
                    : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white"
                }`}
              >
                Top priority
              </button>
              <button
                type="button"
                onClick={() => setPosition("bottom")}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  position === "bottom"
                    ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-400"
                    : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white"
                }`}
              >
                Bottom of queue
              </button>
            </div>
          </div>

          {/* Submit */}
          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-cyan-500 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Add Task
            </button>

            {submitResult && (
              <div
                className={`flex items-center gap-2 text-sm ${
                  submitResult.ok ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {submitResult.ok ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <AlertTriangle className="h-4 w-4" />
                )}
                {submitResult.message}
              </div>
            )}
          </div>
        </form>
      </div>

      {/* Backlog list */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Backlog</h2>
          <button
            onClick={fetchBacklog}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 transition hover:text-white disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {loading && !backlog ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
          </div>
        ) : backlog && backlog.items.length > 0 ? (
          <div className="space-y-2">
            {backlog.items.map((item, i) => (
              <div
                key={i}
                className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
                  item.blocked
                    ? "border-amber-500/20 bg-amber-500/5"
                    : "border-zinc-800 bg-zinc-900"
                }`}
              >
                <div
                  className={`mt-0.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
                    mergedTagColors[item.tag] ?? "bg-zinc-500/15 text-zinc-400 border-zinc-500/25"
                  }`}
                >
                  {item.tag || "\u2014"}
                </div>
                <div className="min-w-0 flex-1">
                  <span className={`text-sm ${item.blocked ? "text-zinc-400" : "text-white"}`}>
                    {item.text.replace(/^\[[^\]]+\]\s*/, "").replace(/\s*\|\s*blockedBy:.*$/i, "")}
                  </span>
                  {item.blockedBy.length > 0 && (
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-400/80">
                      <GitBranch className="h-3 w-3" />
                      <span>
                        {item.blocked ? "Blocked by: " : "Depends on (done): "}
                        {item.blockedBy.join(", ")}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {item.blocked && (
                    <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
                      <Lock className="h-3 w-3" />
                      blocked
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      item.status === "claimed"
                        ? "bg-amber-500/15 text-amber-400"
                        : "bg-zinc-500/15 text-zinc-400"
                    }`}
                  >
                    {item.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-zinc-500">No pending or claimed tasks</p>
        )}
      </div>
    </div>
  );
}
