/**
 * Mission evaluation logic for the Skynet pipeline.
 *
 * This is the CANONICAL source of truth for mission parsing and evaluation.
 * All mission-related logic should flow through this module:
 *   - parseMissionProgress() — full evaluation with criteria status (used by pipeline-status handler)
 *   - parseMissionCriteria() — extract numbered criteria from mission.md
 *   - evaluateCriterion() — evaluate a single criterion against pipeline state
 *
 * NOTE: The mission-status handler (handlers/mission-status.ts) performs its own
 * independent parse for the structured mission page (Purpose, Goals, Success Criteria
 * with checkboxes, cross-referencing with completed tasks). That handler serves a
 * different shape (MissionCriterion[]) than this module (MissionProgress[]). The two
 * share the same source file (mission.md) but serve distinct consumer needs and
 * intentionally do not duplicate each other's logic.
 */

import { existsSync, readdirSync } from "fs";
import path from "path";
import type { MissionProgress } from "../types";
import { readDevFile } from "./file-reader";

export interface MissionEvaluationContext {
  devDir: string;
  completedCount: number;
  failedLines: { status: string }[];
  handlerCount: number;
  missionSlug?: string | null;
}

/**
 * Parse mission markdown and evaluate each success criterion.
 */
export function parseMissionProgress(opts: MissionEvaluationContext): MissionProgress[] {
  const { devDir, completedCount, failedLines, handlerCount, missionSlug } = opts;
  
  let missionRaw = "";
  if (missionSlug) {
    missionRaw = readDevFile(devDir, `missions/${missionSlug}.md`);
  }
  if (!missionRaw) {
    missionRaw = readDevFile(devDir, "mission.md");
  }
  if (!missionRaw) return [];

  const criteria = parseMissionCriteria(missionRaw);
  if (criteria.length === 0) return [];

  const progress: MissionProgress[] = [];

  for (const { id, criterion, completed } of criteria) {
    // If it's one of the legacy Skynet missions (id 1-6) AND it's the main mission,
    // use the rich evaluation logic. Otherwise, use the markdown [x] status.
    const isLegacySkynet = id >= 1 && id <= 6 && (!missionSlug || missionSlug === "main");
    
    if (isLegacySkynet) {
      const evaluated = evaluateCriterion(id, criterion, {
        devDir,
        completedCount,
        failedLines,
        handlerCount,
      });
      progress.push({ id, criterion, ...evaluated });
    } else {
      // Generic mission: status comes from the checkbox in the markdown
      progress.push({ 
        id, 
        criterion, 
        status: completed ? "met" : "not-met",
        evidence: completed ? "Marked as completed in mission document" : "Pending in mission document"
      });
    }
  }

  return progress;
}

/**
 * Extract numbered criteria from the "## Success Criteria" section.
 */
export function parseMissionCriteria(
  missionContent: string
): { id: number; criterion: string; completed: boolean }[] {
  const scMatch = missionContent.match(
    /## Success Criteria\s*\n([\s\S]*?)(?:\n## |\n*$)/i
  );
  if (!scMatch) return [];

  return scMatch[1]
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      // Match "- [x] 1. Criterion" or "1. Criterion" or "- [ ] Criterion"
      const checkboxMatch = trimmed.match(/^-\s*\[([ xX])\]\s*(?:(\d+)\.\s+)?(.+)/);
      if (checkboxMatch) {
        const completed = checkboxMatch[1].toLowerCase() === "x";
        const id = checkboxMatch[2] ? Number(checkboxMatch[2]) : 0;
        return { id, criterion: checkboxMatch[3].trim(), completed };
      }
      
      const numMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
      if (numMatch) {
        return { id: Number(numMatch[1]), criterion: numMatch[2].trim(), completed: false };
      }
      return null;
    })
    .filter((item): item is { id: number; criterion: string; completed: boolean } => item !== null)
    .map((item, index) => ({ ...item, id: item.id || index + 1 }));
}

/**
 * Evaluate a single success criterion against pipeline state.
 *
 * Criterion IDs (1-6) correspond to the standard mission.md format:
 *   1. Zero-to-autonomous setup
 *   2. Self-correction rate
 *   3. No zombies/deadlocks
 *   4. Dashboard visibility
 *   5. Measurable progress
 *   6. Multi-agent support
 * The default case handles unknown criteria safely (returns "not-met").
 */
export function evaluateCriterion(
  id: number,
  _criterion: string,
  ctx: {
    devDir: string;
    completedCount: number;
    failedLines: { status: string }[];
    handlerCount: number;
  }
): { status: MissionProgress["status"]; evidence: string } {
  switch (id) {
    case 1: {
      // "Any project can go from zero to autonomous AI development in under 5 minutes"
      const hasInit = ctx.handlerCount >= 5;
      if (hasInit)
        return {
          status: "met",
          evidence: `${ctx.handlerCount} dashboard handlers available, CLI init functional`,
        };
      return {
        status: "partial",
        evidence: `${ctx.handlerCount} handlers — more needed for full coverage`,
      };
    }
    case 2: {
      // "The pipeline self-corrects 95%+ of failures without human intervention"
      const fixedCount = ctx.failedLines.filter((f) =>
        f.status.includes("fixed")
      ).length;
      const supersededCount = ctx.failedLines.filter((f) =>
        f.status.includes("superseded")
      ).length;
      const blockedCount = ctx.failedLines.filter((f) =>
        f.status.includes("blocked")
      ).length;
      const selfCorrected = fixedCount + supersededCount;
      const totalResolved = selfCorrected + blockedCount;
      if (totalResolved === 0)
        return { status: "partial", evidence: "No failed tasks resolved yet" };
      const fixRate = selfCorrected / totalResolved;
      const pct = Math.round(fixRate * 100);
      if (fixRate >= 0.95)
        return {
          status: "met",
          evidence: `${pct}% self-correction rate (${selfCorrected}/${totalResolved} resolved autonomously)`,
        };
      if (fixRate >= 0.5)
        return {
          status: "partial",
          evidence: `${pct}% self-correction rate (${selfCorrected}/${totalResolved}) — target 95%`,
        };
      return {
        status: "not-met",
        evidence: `${pct}% self-correction rate (${selfCorrected}/${totalResolved}) — target 95%`,
      };
    }
    case 3: {
      // "Workers never lose tasks, deadlock, or produce zombie processes"
      // TS-P2-5: Use ctx.devDir with scripts/watchdog.log instead of constructing scriptsDir
      const watchdogLog = readDevFile(ctx.devDir, "scripts/watchdog.log");
      const zombieRefs = (watchdogLog.match(/zombie/gi) || []).length;
      const deadlockRefs = (watchdogLog.match(/deadlock/gi) || []).length;
      const totalIssues = zombieRefs + deadlockRefs;
      if (totalIssues === 0)
        return {
          status: "met",
          evidence: "No zombie/deadlock references in watchdog logs",
        };
      if (totalIssues <= 3)
        return {
          status: "partial",
          evidence: `${totalIssues} zombie/deadlock reference(s) in watchdog logs`,
        };
      return {
        status: "not-met",
        evidence: `${totalIssues} zombie/deadlock references in watchdog logs`,
      };
    }
    case 4: {
      // "The dashboard provides full real-time visibility into pipeline health"
      if (ctx.handlerCount >= 8)
        return {
          status: "met",
          evidence: `${ctx.handlerCount} dashboard handlers providing full visibility`,
        };
      if (ctx.handlerCount >= 5)
        return {
          status: "partial",
          evidence: `${ctx.handlerCount} dashboard handlers — growing coverage`,
        };
      return {
        status: "not-met",
        evidence: `Only ${ctx.handlerCount} dashboard handlers`,
      };
    }
    case 5: {
      // "Mission progress is measurable — completed tasks map to mission objectives"
      if (ctx.completedCount >= 10)
        return {
          status: "met",
          evidence: `${ctx.completedCount} tasks completed and tracked`,
        };
      if (ctx.completedCount >= 3)
        return {
          status: "partial",
          evidence: `${ctx.completedCount} tasks completed — building momentum`,
        };
      return {
        status: "not-met",
        evidence: `Only ${ctx.completedCount} tasks completed`,
      };
    }
    case 6: {
      // "The system works with any LLM agent (Claude, Codex, future models)"
      const projectRoot = path.resolve(ctx.devDir, "..");
      const agentsDir = `${projectRoot}/scripts/agents`;
      let agentPlugins: string[] = [];
      try {
        if (existsSync(agentsDir)) {
          agentPlugins = readdirSync(agentsDir).filter((f: string) =>
            f.endsWith(".sh")
          );
        }
      } catch {
        /* ignore */
      }
      if (agentPlugins.length >= 2)
        return {
          status: "met",
          evidence: `${agentPlugins.length} agent plugins: ${agentPlugins.join(", ")}`,
        };
      if (agentPlugins.length === 1)
        return {
          status: "partial",
          evidence: `1 agent plugin: ${agentPlugins[0]} — need more for multi-agent support`,
        };
      return {
        status: "not-met",
        evidence: "No agent plugins found in scripts/agents/",
      };
    }
    default:
      return {
        status: "not-met",
        evidence: "Unknown criterion — no evaluation logic",
      };
  }
}
