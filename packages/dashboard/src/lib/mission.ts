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
}

/**
 * Parse mission.md and evaluate each success criterion against the current pipeline state.
 * Returns an array of MissionProgress items with status and evidence.
 */
export function parseMissionProgress(opts: MissionEvaluationContext): MissionProgress[] {
  const { devDir, completedCount, failedLines, handlerCount } = opts;
  const missionRaw = readDevFile(devDir, "mission.md");
  if (!missionRaw) return [];

  const criteria = parseMissionCriteria(missionRaw);
  if (criteria.length === 0) return [];

  const progress: MissionProgress[] = [];

  for (const { id, criterion } of criteria) {
    const evaluated = evaluateCriterion(id, criterion, {
      devDir,
      completedCount,
      failedLines,
      handlerCount,
    });
    progress.push({ id, criterion, ...evaluated });
  }

  return progress;
}

/**
 * Extract numbered criteria from the "## Success Criteria" section of mission.md content.
 */
export function parseMissionCriteria(
  missionContent: string
): { id: number; criterion: string }[] {
  const scMatch = missionContent.match(
    /## Success Criteria\s*\n([\s\S]*?)(?:\n## |\n*$)/i
  );
  if (!scMatch) return [];

  return scMatch[1]
    .split("\n")
    .filter((l) => /^\d+\.\s/.test(l.trim()))
    .map((line) => {
      const numMatch = line.trim().match(/^(\d+)\.\s+(.+)/);
      if (!numMatch) return null;
      return { id: Number(numMatch[1]), criterion: numMatch[2] };
    })
    .filter((item): item is { id: number; criterion: string } => item !== null);
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
