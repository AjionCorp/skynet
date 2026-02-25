"use client";

import { useCallback, useState } from "react";
import {
  Wand2,
  ChevronDown,
  Check,
  Pencil,
  Loader2,
  X,
  Plus,
  Save,
} from "lucide-react";
import type { MissionCreatorSuggestion } from "../types";
import { useSkynet } from "./SkynetProvider";

export interface MissionCreatorProps {
  currentMission: string;
  onApply: (content: string) => void;
  onClose: () => void;
}

let nextId = 0;
function uid(): string {
  return `suggestion-${++nextId}-${Date.now()}`;
}

function updateTree(
  nodes: MissionCreatorSuggestion[],
  id: string,
  updater: (n: MissionCreatorSuggestion) => MissionCreatorSuggestion,
): MissionCreatorSuggestion[] {
  return nodes.map((n) =>
    n.id === id
      ? updater(n)
      : { ...n, children: updateTree(n.children, id, updater) },
  );
}

function findNode(
  nodes: MissionCreatorSuggestion[],
  id: string,
): MissionCreatorSuggestion | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SuggestionNode — renders one suggestion card recursively
// ---------------------------------------------------------------------------

interface SuggestionNodeProps {
  node: MissionCreatorSuggestion;
  depth: number;
  onExpand: (id: string) => void;
  onApply: (id: string) => void;
  onEdit: (id: string, content: string) => void;
}

function SuggestionNode({ node, depth, onExpand, onApply, onEdit }: SuggestionNodeProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.content);

  const borderColor = node.applied
    ? "border-emerald-500/30 bg-emerald-500/5"
    : "border-amber-500/20 bg-amber-500/5";

  return (
    <div className={depth > 0 ? "ml-6 border-l-2 border-zinc-800 pl-4" : ""}>
      <div className={`rounded-xl border ${borderColor} p-4 transition`}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-white">{node.title}</h4>
          <div className="flex shrink-0 items-center gap-1.5">
            {!node.applied && (
              <button
                onClick={() => onApply(node.id)}
                className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-400 transition hover:bg-emerald-500/20"
                title="Apply to mission"
              >
                <Check className="h-3 w-3" />
                Apply
              </button>
            )}
            {node.applied && (
              <span className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-400">
                <Check className="h-3 w-3" />
                Applied
              </span>
            )}
            <button
              onClick={() => onExpand(node.id)}
              disabled={node.loading}
              className="flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-xs font-medium text-cyan-400 transition hover:bg-cyan-500/20 disabled:opacity-50"
              title="Expand into sub-suggestions"
            >
              {node.loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              Expand
            </button>
            <button
              onClick={() => {
                setDraft(node.content);
                setEditing(!editing);
              }}
              className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-400 transition hover:text-white"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </div>
        </div>
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-24 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-300 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
            />
            <div className="flex justify-end gap-1.5">
              <button
                onClick={() => setEditing(false)}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onEdit(node.id, draft);
                  setEditing(false);
                }}
                className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-400 hover:bg-cyan-500/20"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-zinc-400">{node.content}</p>
        )}
      </div>
      {node.children.length > 0 && (
        <div className="mt-3 space-y-3">
          {node.children.map((child) => (
            <SuggestionNode
              key={child.id}
              node={child}
              depth={depth + 1}
              onExpand={onExpand}
              onApply={onApply}
              onEdit={onEdit}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MissionCreator — main component
// ---------------------------------------------------------------------------

export function MissionCreator({ currentMission, onApply, onClose }: MissionCreatorProps) {
  const { apiPrefix } = useSkynet();

  const [userInput, setUserInput] = useState("");
  const [generatedMission, setGeneratedMission] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<MissionCreatorSuggestion[]>([]);
  const [generating, setGenerating] = useState(false);
  const [editingMission, setEditingMission] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    if (!userInput.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`${apiPrefix}/mission/creator`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: userInput, currentMission: currentMission || undefined }),
      });
      const json = await res.json();
      if (json.error) {
        setError(json.error);
      } else {
        setGeneratedMission(json.data.mission);
        setSuggestions(
          json.data.suggestions.map((s: { title: string; content: string }) => ({
            id: uid(),
            title: s.title,
            content: s.content,
            applied: false,
            children: [],
            loading: false,
          })),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate mission");
    } finally {
      setGenerating(false);
    }
  }, [apiPrefix, userInput, currentMission]);

  const handleExpand = useCallback(
    async (id: string) => {
      const node = findNode(suggestions, id);
      if (!node || node.loading) return;

      // Set loading
      setSuggestions((prev) => updateTree(prev, id, (n) => ({ ...n, loading: true })));

      try {
        const res = await fetch(`${apiPrefix}/mission/creator/expand`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            suggestion: node.content,
            currentMission: generatedMission || currentMission || undefined,
          }),
        });
        const json = await res.json();
        if (json.error) {
          setError(json.error);
          setSuggestions((prev) => updateTree(prev, id, (n) => ({ ...n, loading: false })));
        } else {
          const children: MissionCreatorSuggestion[] = json.data.suggestions.map(
            (s: { title: string; content: string }) => ({
              id: uid(),
              title: s.title,
              content: s.content,
              applied: false,
              children: [],
              loading: false,
            }),
          );
          setSuggestions((prev) =>
            updateTree(prev, id, (n) => ({
              ...n,
              loading: false,
              children: [...n.children, ...children],
            })),
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to expand suggestion");
        setSuggestions((prev) => updateTree(prev, id, (n) => ({ ...n, loading: false })));
      }
    },
    [apiPrefix, suggestions, generatedMission, currentMission],
  );

  const handleApplySuggestion = useCallback(
    (id: string) => {
      const node = findNode(suggestions, id);
      if (!node || node.applied || !generatedMission) return;

      // Append suggestion content to mission
      setGeneratedMission((prev) => (prev ?? "") + "\n\n## " + node.title + "\n" + node.content);
      setSuggestions((prev) => updateTree(prev, id, (n) => ({ ...n, applied: true })));
    },
    [suggestions, generatedMission],
  );

  const handleEditSuggestion = useCallback((id: string, content: string) => {
    setSuggestions((prev) => updateTree(prev, id, (n) => ({ ...n, content })));
  }, []);

  const handleApplyMission = useCallback(() => {
    if (generatedMission) {
      onApply(generatedMission);
    }
  }, [generatedMission, onApply]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wand2 className="h-5 w-5 text-violet-400" />
          <h2 className="text-lg font-semibold text-white">AI Mission Creator</h2>
        </div>
        <button
          onClick={onClose}
          className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
          Close
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Input Node */}
      <div className="rounded-xl border border-cyan-500/20 bg-zinc-900/50 p-5">
        <div className="mb-3 flex items-center gap-2">
          <Plus className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-white">Describe Your Mission</h3>
        </div>
        <textarea
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          placeholder="Describe what you want to achieve... e.g., 'Build an autonomous CI/CD pipeline that handles deployments, monitoring, and self-healing'"
          className="mb-3 h-28 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-sm leading-relaxed text-zinc-300 placeholder-zinc-600 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
        />
        <button
          onClick={handleGenerate}
          disabled={generating || !userInput.trim()}
          className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-2 text-sm font-medium text-violet-400 transition hover:border-violet-500/50 hover:bg-violet-500/20 disabled:opacity-50"
        >
          {generating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Wand2 className="h-4 w-4" />
          )}
          {generating ? "Generating..." : "Generate with AI"}
        </button>
      </div>

      {/* Generated Mission Node */}
      {generatedMission !== null && (
        <div className="rounded-xl border border-emerald-500/20 bg-zinc-900/50 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-white">Generated Mission</h3>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setEditingMission(!editingMission)}
                className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-400 transition hover:text-white"
              >
                <Pencil className="h-3 w-3" />
                {editingMission ? "Preview" : "Edit"}
              </button>
              <button
                onClick={handleApplyMission}
                className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 transition hover:border-emerald-500/50 hover:bg-emerald-500/20"
              >
                <Save className="h-3 w-3" />
                Apply to Mission
              </button>
            </div>
          </div>
          {editingMission ? (
            <textarea
              value={generatedMission}
              onChange={(e) => setGeneratedMission(e.target.value)}
              className="h-64 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
            />
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-300">
              {generatedMission}
            </pre>
          )}
        </div>
      )}

      {/* Suggestion Nodes */}
      {suggestions.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <ChevronDown className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-white">Improvement Suggestions</h3>
          </div>
          {suggestions.map((node) => (
            <SuggestionNode
              key={node.id}
              node={node}
              depth={0}
              onExpand={handleExpand}
              onApply={handleApplySuggestion}
              onEdit={handleEditSuggestion}
            />
          ))}
        </div>
      )}
    </div>
  );
}
