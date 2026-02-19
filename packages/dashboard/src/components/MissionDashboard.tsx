"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  Target,
} from "lucide-react";
import type { MissionData, MissionSection } from "../types";
import { useSkynet } from "./SkynetProvider";

// ===== Helpers =====

/** Render inline markdown: **bold** and `code` */
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <span key={i} className="font-semibold text-white">
          {part.slice(2, -2)}
        </span>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-cyan-400"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

/** Render a section's content lines with basic markdown highlighting */
function SectionContent({ content }: { content: string }) {
  const lines = content.split("\n");

  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        if (!line.trim()) return null;

        // Numbered list
        const numMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
        if (numMatch) {
          return (
            <p key={i} className="text-sm text-zinc-300 pl-4">
              <span className="text-zinc-500 mr-2">{line.match(/\d+/)![0]}.</span>
              {renderInline(numMatch[2])}
            </p>
          );
        }

        // Bullet list
        const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)/);
        if (bulletMatch) {
          return (
            <p key={i} className="text-sm text-zinc-300 pl-4">
              <span className="text-zinc-500 mr-2">&bull;</span>
              {renderInline(bulletMatch[2])}
            </p>
          );
        }

        // Regular text (skip HTML comments)
        if (line.trim().startsWith("<!--")) return null;

        return (
          <p key={i} className="text-sm text-zinc-300">
            {renderInline(line)}
          </p>
        );
      })}
    </div>
  );
}

function CriteriaPanel({
  criteria,
}: {
  criteria: MissionData["criteria"];
}) {
  const doneCount = criteria.filter((c) => c.status === "done").length;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-cyan-400" />
          <h3 className="font-medium text-white">Success Criteria</h3>
        </div>
        <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-400">
          {doneCount}/{criteria.length} complete
        </span>
      </div>
      <div className="divide-y divide-zinc-800/50">
        {criteria.map((c, i) => (
          <div key={i} className="flex items-start gap-3 px-5 py-3">
            {c.status === "done" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
            )}
            <span
              className={`text-sm ${
                c.status === "done"
                  ? "text-zinc-500 line-through"
                  : "text-zinc-300"
              }`}
            >
              {renderInline(c.text)}
            </span>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div className="border-t border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-cyan-500 transition-all duration-500"
              style={{
                width: criteria.length > 0
                  ? `${(doneCount / criteria.length) * 100}%`
                  : "0%",
              }}
            />
          </div>
          <span className="text-xs font-medium text-zinc-500">
            {criteria.length > 0
              ? `${Math.round((doneCount / criteria.length) * 100)}%`
              : "0%"}
          </span>
        </div>
      </div>
    </div>
  );
}

function MissionSectionCard({ section }: { section: MissionSection }) {
  // Skip the success criteria section since we render it separately
  if (section.heading.toLowerCase().includes("success criteria")) return null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
      <div className="border-b border-zinc-800 px-5 py-3">
        <h3 className="font-medium text-white">{section.heading}</h3>
      </div>
      <div className="px-5 py-4">
        <SectionContent content={section.content} />
      </div>
    </div>
  );
}

// ===== Main Component =====

export interface MissionDashboardProps {}

export function MissionDashboard(_props: MissionDashboardProps) {
  const { apiPrefix } = useSkynet();

  const [mission, setMission] = useState<MissionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMission = useCallback(async () => {
    try {
      const res = await fetch(`${apiPrefix}/mission`);
      const json = await res.json();
      if (json.error) {
        setError(json.error);
        return;
      }
      setMission(json.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch mission");
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  useEffect(() => {
    fetchMission();
  }, [fetchMission]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
        <span className="ml-3 text-sm text-zinc-500">Loading mission...</span>
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

  if (!mission || !mission.raw) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Target className="h-10 w-10 text-zinc-600 mb-3" />
        <p className="text-sm text-zinc-500">
          No mission.md found. Create one in your .dev/ directory to drive
          autonomous development.
        </p>
      </div>
    );
  }

  // Separate level-1 heading sections from sub-sections
  const topSections = mission.sections.filter((s) => s.level <= 2);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">{mission.title}</h2>
        <p className="mt-1 text-sm text-zinc-500">
          {mission.sections.length} section{mission.sections.length !== 1 ? "s" : ""}{" "}
          &middot; {mission.criteria.length} success criteri{mission.criteria.length !== 1 ? "a" : "on"}
        </p>
      </div>

      {/* Success Criteria panel — always at the top */}
      {mission.criteria.length > 0 && (
        <CriteriaPanel criteria={mission.criteria} />
      )}

      {/* Mission sections */}
      <div className="space-y-4">
        {topSections.map((section, i) => (
          <MissionSectionCard key={i} section={section} />
        ))}
      </div>
    </div>
  );
}
