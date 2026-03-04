import type {
  SkynetConfig,
  FailedTask,
  FailureAnalysis,
  ErrorPattern,
  FailureTimelinePoint,
  WorkerFailureStats,
} from "../types";
import { readDevFile } from "../lib/file-reader";
import { getSkynetDB } from "../lib/db";
import { logHandlerError } from "../lib/handler-error";

// ── Error pattern normalisation ─────────────────────────────────────

const PATTERN_RULES: Array<{ test: RegExp; label: string }> = [
  { test: /merge conflict/i, label: "merge conflict" },
  { test: /typecheck fail/i, label: "typecheck failure" },
  { test: /usage limit/i, label: "usage limits" },
  { test: /claude exit code/i, label: "claude exit code" },
  { test: /worktree missing/i, label: "worktree missing" },
  { test: /phantom completion/i, label: "phantom completion" },
  { test: /timeout/i, label: "timeout" },
];

function classifyError(error: string): string {
  for (const rule of PATTERN_RULES) {
    if (rule.test.test(error)) return rule.label;
  }
  return error.length > 0 ? "other" : "unknown";
}

// ── File-based fallback parser ──────────────────────────────────────

function parseFailedTasksFile(devDir: string): FailedTask[] {
  const raw = readDevFile(devDir, "failed-tasks.md");
  const lines = raw
    .split("\n")
    .filter(
      (l) =>
        l.startsWith("|") && !l.includes("Date") && !l.includes("---"),
    );

  return lines.map((line) => {
    const parts = line.split("|").map((p) => p.trim());
    return {
      date: parts[1] ?? "",
      task: parts[2] ?? "",
      branch: parts[3] ?? "",
      error: parts[4] ?? "",
      attempts: parts[6] ?? "0",
      status: parts[7] ?? "failed",
      outcomeReason: "",
      filesTouched: "",
    };
  });
}

// ── Analysis logic ──────────────────────────────────────────────────

interface FailedTaskWithWorker extends FailedTask {
  workerId: number | null;
  attemptsNum: number;
}

function buildAnalysis(tasks: FailedTaskWithWorker[]): FailureAnalysis {
  // Summary counts
  let fixed = 0;
  let blocked = 0;
  let superseded = 0;
  let pending = 0;

  for (const t of tasks) {
    if (t.status === "fixed") fixed++;
    else if (t.status === "blocked") blocked++;
    else if (t.status === "superseded") superseded++;
    else if (t.status === "failed" || t.status.startsWith("fixing-")) pending++;
  }

  const total = tasks.length;
  const selfCorrected = fixed + superseded;

  // Error patterns
  const patternMap = new Map<string, { count: number; tasks: Set<string> }>();
  for (const t of tasks) {
    const pattern = classifyError(t.error);
    const entry = patternMap.get(pattern) ?? { count: 0, tasks: new Set<string>() };
    entry.count++;
    entry.tasks.add(t.task);
    patternMap.set(pattern, entry);
  }
  const errorPatterns: ErrorPattern[] = Array.from(patternMap.entries())
    .map(([pattern, v]) => ({ pattern, count: v.count, tasks: Array.from(v.tasks) }))
    .sort((a, b) => b.count - a.count);

  // Timeline by date
  const timelineMap = new Map<string, FailureTimelinePoint>();
  for (const t of tasks) {
    const date = t.date || "unknown";
    const point = timelineMap.get(date) ?? { date, failures: 0, fixed: 0, blocked: 0, superseded: 0 };
    point.failures++;
    if (t.status === "fixed") point.fixed++;
    else if (t.status === "blocked") point.blocked++;
    else if (t.status === "superseded") point.superseded++;
    timelineMap.set(date, point);
  }
  const timeline = Array.from(timelineMap.values())
    .filter((p) => p.date !== "unknown")
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);

  // Per-worker stats
  const byWorker: WorkerFailureStats[] = [];
  const workerMap = new Map<number, { failures: number; fixed: number; totalAttempts: number }>();
  for (const t of tasks) {
    if (t.workerId == null) continue;
    const entry = workerMap.get(t.workerId) ?? { failures: 0, fixed: 0, totalAttempts: 0 };
    entry.failures++;
    if (t.status === "fixed") entry.fixed++;
    entry.totalAttempts += t.attemptsNum;
    workerMap.set(t.workerId, entry);
  }
  for (const [workerId, stats] of workerMap.entries()) {
    byWorker.push({
      workerId,
      failures: stats.failures,
      fixed: stats.fixed,
      avgAttempts: stats.failures > 0 ? Math.round((stats.totalAttempts / stats.failures) * 10) / 10 : 0,
    });
  }
  byWorker.sort((a, b) => b.failures - a.failures);

  // Recent failures (pending/fixing, newest first, max 10)
  const recentFailures: FailedTask[] = tasks
    .filter((t) => t.status === "failed" || t.status.startsWith("fixing-"))
    .slice(0, 10)
    .map(({ workerId: _w, attemptsNum: _a, ...ft }) => ft);

  return {
    summary: { total, fixed, blocked, superseded, pending, selfCorrected },
    errorPatterns,
    timeline,
    byWorker,
    recentFailures,
  };
}

// ── Handler factory ─────────────────────────────────────────────────

export function createPipelineFailureAnalysisHandler(config: SkynetConfig) {
  const { devDir } = config;

  return async function GET(): Promise<Response> {
    try {
      // Try SQLite first
      try {
        const db = getSkynetDB(devDir, { readonly: true });
        const rows = db.getFailedTasksWithWorker();
        const tasks: FailedTaskWithWorker[] = rows.map((r) => ({
          date: r.date,
          task: r.task,
          branch: r.branch,
          error: r.error,
          attempts: String(r.attempts),
          status: r.status,
          outcomeReason: "",
          filesTouched: "",
          workerId: r.workerId,
          attemptsNum: r.attempts,
        }));
        const analysis = buildAnalysis(tasks);
        return Response.json({ data: analysis, error: null });
      } catch {
        // Fall back to file-based parsing
        const fileTasks = parseFailedTasksFile(devDir);
        const tasks: FailedTaskWithWorker[] = fileTasks.map((ft) => ({
          ...ft,
          workerId: null,
          attemptsNum: parseInt(ft.attempts, 10) || 0,
        }));
        const analysis = buildAnalysis(tasks);
        return Response.json({ data: analysis, error: null });
      }
    } catch (err) {
      logHandlerError(devDir, "pipeline-failure-analysis:GET", err);
      return Response.json(
        {
          data: null,
          error:
            process.env.NODE_ENV === "development" && err instanceof Error
              ? err.message
              : "Failed to analyse pipeline failures",
        },
        { status: 500 },
      );
    }
  };
}
