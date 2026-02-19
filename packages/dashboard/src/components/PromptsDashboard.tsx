"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
} from "lucide-react";
import type { PromptTemplate } from "../types";
import { useSkynet } from "./SkynetProvider";

const CATEGORY_STYLES: Record<string, string> = {
  core: "bg-cyan-500/15 text-cyan-400 border-cyan-500/25",
  testing: "bg-orange-500/15 text-orange-400 border-orange-500/25",
  infra: "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",
  data: "bg-violet-500/15 text-violet-400 border-violet-500/25",
};

function HighlightedPrompt({ text }: { text: string }) {
  const parts = text.split(/(\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*)/g);

  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-zinc-300">
      {parts.map((part, i) =>
        /^\$/.test(part) ? (
          <span key={i} className="text-amber-400 font-semibold">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </pre>
  );
}

export interface PromptsDashboardProps {
  scripts?: string[];
}

export function PromptsDashboard({ scripts }: PromptsDashboardProps = {}) {
  const { apiPrefix } = useSkynet();

  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchPrompts = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/prompts`);
      const json = await res.json();
      if (json.error) {
        setError(json.error);
        return;
      }
      let data: PromptTemplate[] = json.data ?? [];
      if (scripts) {
        data = data.filter((p) => scripts.includes(p.scriptName));
      }
      setPrompts(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch prompts");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix, scripts]);

  useEffect(() => {
    fetchPrompts();
  }, [fetchPrompts]);

  const toggle = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        <span className="ml-3 text-sm text-zinc-500">Loading prompt templates...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-6 py-4">
        <AlertTriangle className="h-5 w-5 text-red-400" />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Prompt Templates</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {prompts.length} worker prompt{prompts.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setExpanded(new Set(prompts.map((p) => p.scriptName)))}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
          >
            Expand All
          </button>
          <button
            onClick={() => setExpanded(new Set())}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
          >
            Collapse All
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {prompts.map((p) => {
          const isOpen = expanded.has(p.scriptName);
          const catStyle = CATEGORY_STYLES[p.category] ?? CATEGORY_STYLES.core;
          return (
            <div key={p.scriptName} className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
              <button
                onClick={() => toggle(p.scriptName)}
                className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-zinc-800/50"
              >
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
                )}
                <FileText className="h-4 w-4 shrink-0 text-zinc-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">{p.workerLabel}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${catStyle}`}>
                      {p.category}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {p.scriptName}.sh{p.description ? ` — ${p.description}` : ""}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-zinc-600">
                  {p.prompt.split("\n").length} lines
                </span>
              </button>

              {isOpen && (
                <div className="border-t border-zinc-800 bg-zinc-950/50 px-5 py-4">
                  <HighlightedPrompt text={p.prompt} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
