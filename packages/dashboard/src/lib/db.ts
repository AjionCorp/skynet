import type {
  BacklogItem,
  CompletedTask,
  FailedTask,
  EventEntry,
  SelfCorrectionStats,
} from "../types";

// better-sqlite3 is a peer/optional dependency — handlers that call SkynetDB
// must ensure it's installed.  We use a lazy require so the rest of the package
// can still be imported in environments without the native addon.
type BetterSqlite3 = typeof import("better-sqlite3");
type Database = import("better-sqlite3").Database;

let _betterSqlite3: BetterSqlite3 | null = null;
function loadDriver(): BetterSqlite3 {
  if (!_betterSqlite3) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _betterSqlite3 = require("better-sqlite3") as BetterSqlite3;
  }
  return _betterSqlite3;
}

// ─── Row shapes returned by SELECT queries ───────────────────────────

interface TaskRow {
  id: number;
  title: string;
  tag: string;
  description: string;
  status: string;
  blocked_by: string;
  branch: string;
  worker_id: number | null;
  fixer_id: number | null;
  error: string;
  attempts: number;
  duration: string;
  duration_secs: number | null;
  notes: string;
  priority: number;
  normalized_root: string;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
}

interface BlockerRow {
  id: number;
  description: string;
  task_title: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

interface WorkerRow {
  id: number;
  worker_type: string;
  status: string;
  current_task_id: number | null;
  task_title: string;
  branch: string;
  started_at: string | null;
  heartbeat_epoch: number | null;
  last_info: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  epoch: number;
  event: string;
  detail: string;
  worker_id: number | null;
  created_at: string;
}

interface FixerStatRow {
  id: number;
  epoch: number;
  result: string;
  task_title: string;
  fixer_id: number | null;
  created_at: string;
}

// ─── SkynetDB class ─────────────────────────────────────────────────

export class SkynetDB {
  private db: Database;

  constructor(dbPath: string) {
    const Database = loadDriver();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  close(): void {
    this.db.close();
  }

  // ── Backlog / Tasks ────────────────────────────────────────────────

  /** Returns backlog items matching the dashboard shape. */
  getBacklogItems(): {
    items: BacklogItem[];
    pendingCount: number;
    claimedCount: number;
    doneCount: number;
  } {
    const rows = this.db
      .prepare(
        `SELECT id, title, tag, description, status, blocked_by, priority
         FROM tasks
         WHERE status IN ('pending','claimed','done')
         ORDER BY priority ASC`
      )
      .all() as Pick<TaskRow, "id" | "title" | "tag" | "description" | "status" | "blocked_by" | "priority">[];

    // Build title→status map for blocked resolution
    const titleToStatus = new Map<string, string>();
    for (const r of rows) titleToStatus.set(r.title, r.status);

    let pendingCount = 0;
    let claimedCount = 0;
    let doneCount = 0;

    const items: BacklogItem[] = rows.map((r) => {
      const status = r.status as "pending" | "claimed" | "done";
      if (status === "pending") pendingCount++;
      else if (status === "claimed") claimedCount++;
      else if (status === "done") doneCount++;

      const blockedBy = r.blocked_by
        ? r.blocked_by.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      const blocked =
        blockedBy.length > 0 &&
        blockedBy.some((dep) => titleToStatus.get(dep) !== "done");

      const desc = r.description ? ` \u2014 ${r.description}` : "";
      const blockedSuffix = r.blocked_by ? ` | blockedBy: ${r.blocked_by}` : "";

      return {
        text: `[${r.tag}] ${r.title}${desc}${blockedSuffix}`,
        tag: r.tag,
        status,
        blockedBy,
        blocked,
      };
    });

    return { items, pendingCount, claimedCount, doneCount };
  }

  /** Completed tasks (most recent first). */
  getCompletedTasks(limit = 50): CompletedTask[] {
    const rows = this.db
      .prepare(
        `SELECT completed_at, title, branch, duration, notes
         FROM tasks
         WHERE status IN ('completed','fixed')
         ORDER BY completed_at DESC
         LIMIT ?`
      )
      .all(limit) as Pick<TaskRow, "completed_at" | "title" | "branch" | "duration" | "notes">[];

    return rows.map((r) => ({
      date: r.completed_at ? r.completed_at.slice(0, 10) : "",
      task: r.title,
      branch: r.branch ?? "",
      duration: r.duration ?? "",
      notes: r.notes ?? "",
    }));
  }

  getCompletedCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status IN ('completed','fixed')")
      .get() as { cnt: number };
    return row.cnt;
  }

  /** Average duration in minutes, formatted as human-readable string. */
  getAverageTaskDuration(): string | null {
    const row = this.db
      .prepare(
        `SELECT AVG(duration_secs) as avg_secs
         FROM tasks
         WHERE status IN ('completed','fixed') AND duration_secs IS NOT NULL AND duration_secs > 0`
      )
      .get() as { avg_secs: number | null };

    if (!row.avg_secs) return null;
    const minutes = row.avg_secs / 60;
    if (minutes < 60) return `${Math.round(minutes)}m`;
    const h = Math.floor(minutes / 60);
    const rem = Math.round(minutes % 60);
    return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
  }

  /** Failed tasks for the pipeline-status handler. */
  getFailedTasks(): FailedTask[] {
    const rows = this.db
      .prepare(
        `SELECT failed_at, title, branch, error, attempts, status
         FROM tasks
         WHERE status IN ('failed','blocked','fixed','superseded')
            OR status LIKE 'fixing-%'
         ORDER BY failed_at DESC`
      )
      .all() as Pick<TaskRow, "failed_at" | "title" | "branch" | "error" | "attempts" | "status">[];

    return rows.map((r) => ({
      date: r.failed_at ? r.failed_at.slice(0, 10) : "",
      task: r.title,
      branch: r.branch ?? "",
      error: r.error ?? "",
      attempts: String(r.attempts ?? 0),
      status: r.status,
    }));
  }

  /** Self-correction breakdown. */
  getSelfCorrectionStats(): SelfCorrectionStats {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) as cnt
         FROM tasks
         WHERE status IN ('failed','blocked','fixed','superseded')
            OR status LIKE 'fixing-%'
         GROUP BY status`
      )
      .all() as { status: string; cnt: number }[];

    let fixed = 0;
    let blocked = 0;
    let superseded = 0;
    let pending = 0;

    for (const r of rows) {
      if (r.status === "fixed") fixed = r.cnt;
      else if (r.status === "blocked") blocked = r.cnt;
      else if (r.status === "superseded") superseded = r.cnt;
      else if (r.status === "failed" || r.status.startsWith("fixing-")) pending += r.cnt;
    }

    return { fixed, blocked, superseded, pending, selfCorrected: fixed + superseded };
  }

  /** Add a task (used by dashboard POST and CLI add-task). Returns new task ID. */
  addTask(
    title: string,
    tag: string,
    description = "",
    position: "top" | "bottom" = "top",
    blockedBy = ""
  ): number {
    const normalizedRoot = title
      .replace(/\[[A-Z]*\]\s*/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50);

    if (position === "top") {
      this.db.prepare("UPDATE tasks SET priority=priority+1 WHERE status IN ('pending','claimed')").run();
      const info = this.db
        .prepare(
          `INSERT INTO tasks (title, tag, description, status, blocked_by, normalized_root, priority)
           VALUES (?, ?, ?, 'pending', ?, ?, 0)`
        )
        .run(title, tag, description, blockedBy, normalizedRoot);
      return Number(info.lastInsertRowid);
    }

    const row = this.db
      .prepare("SELECT COALESCE(MAX(priority),0)+1 as next FROM tasks WHERE status IN ('pending','claimed')")
      .get() as { next: number };
    const info = this.db
      .prepare(
        `INSERT INTO tasks (title, tag, description, status, blocked_by, normalized_root, priority)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(title, tag, description, blockedBy, normalizedRoot, row.next);
    return Number(info.lastInsertRowid);
  }

  // ── Current Tasks / Workers ────────────────────────────────────────

  /** Get a single worker's current task info (matches parseCurrentTask shape). */
  getCurrentTask(workerId: number): {
    status: string;
    title: string | null;
    branch: string | null;
    started: string | null;
    worker: string | null;
    lastInfo: string | null;
  } {
    const row = this.db
      .prepare("SELECT * FROM workers WHERE id = ?")
      .get(workerId) as WorkerRow | undefined;

    if (!row) {
      return { status: "unknown", title: null, branch: null, started: null, worker: null, lastInfo: null };
    }
    return {
      status: row.status,
      title: row.task_title || null,
      branch: row.branch || null,
      started: row.started_at,
      worker: `Worker ${row.id}`,
      lastInfo: row.last_info || null,
    };
  }

  /** Get all workers' current tasks. */
  getAllCurrentTasks(maxWorkers: number): Record<string, ReturnType<SkynetDB["getCurrentTask"]>> {
    const result: Record<string, ReturnType<SkynetDB["getCurrentTask"]>> = {};
    for (let wid = 1; wid <= maxWorkers; wid++) {
      const task = this.getCurrentTask(wid);
      if (task.status !== "unknown") {
        result[`worker-${wid}`] = task;
      }
    }
    return result;
  }

  /** Get heartbeats for all workers. */
  getHeartbeats(maxWorkers: number): Record<string, { lastEpoch: number | null; ageMs: number | null; isStale: boolean }> {
    const staleMs = 45 * 60 * 1000;
    const result: Record<string, { lastEpoch: number | null; ageMs: number | null; isStale: boolean }> = {};
    const rows = this.db
      .prepare("SELECT id, heartbeat_epoch FROM workers WHERE id <= ?")
      .all(maxWorkers) as Pick<WorkerRow, "id" | "heartbeat_epoch">[];

    const workerMap = new Map<number, number | null>();
    for (const r of rows) workerMap.set(r.id, r.heartbeat_epoch);

    for (let wid = 1; wid <= maxWorkers; wid++) {
      const epoch = workerMap.get(wid) ?? null;
      if (epoch) {
        const ageMs = Date.now() - epoch * 1000;
        result[`worker-${wid}`] = { lastEpoch: epoch, ageMs, isStale: ageMs > staleMs };
      } else {
        result[`worker-${wid}`] = { lastEpoch: null, ageMs: null, isStale: false };
      }
    }
    return result;
  }

  // ── Blockers ───────────────────────────────────────────────────────

  /** Active blocker lines (for dashboard display). */
  getActiveBlockerLines(): string[] {
    const rows = this.db
      .prepare("SELECT description FROM blockers WHERE status='active' ORDER BY created_at ASC")
      .all() as Pick<BlockerRow, "description">[];
    return rows.map((r) => `- ${r.description}`);
  }

  getActiveBlockerCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM blockers WHERE status='active'")
      .get() as { cnt: number };
    return row.cnt;
  }

  // ── Events ─────────────────────────────────────────────────────────

  /** Recent events formatted for the events handler. */
  getRecentEvents(limit = 100): EventEntry[] {
    const rows = this.db
      .prepare("SELECT epoch, event, detail, worker_id FROM events ORDER BY epoch DESC LIMIT ?")
      .all(limit) as Pick<EventRow, "epoch" | "event" | "detail" | "worker_id">[];

    return rows.map((r) => ({
      ts: new Date(r.epoch * 1000).toISOString(),
      event: r.event,
      worker: r.worker_id ?? undefined,
      detail: r.detail ?? "",
    }));
  }

  // ── Health Score ───────────────────────────────────────────────────

  /** Calculate pipeline health score (0-100). */
  calculateHealthScore(maxWorkers: number): number {
    const failedPending = (
      this.db
        .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status='failed'")
        .get() as { cnt: number }
    ).cnt;

    const blockerCount = this.getActiveBlockerCount();

    const staleMs = 45 * 60 * 1000;
    let staleHbs = 0;
    const hbs = this.getHeartbeats(maxWorkers);
    for (const hb of Object.values(hbs)) {
      if (hb.isStale) staleHbs++;
    }

    const staleTasks = (
      this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM workers
           WHERE status='in_progress' AND started_at IS NOT NULL
             AND (julianday('now')-julianday(started_at))>1`
        )
        .get() as { cnt: number }
    ).cnt;

    let score = 100 - failedPending * 5 - blockerCount * 10 - staleHbs * 2 - staleTasks;
    return Math.max(0, Math.min(100, score));
  }

  // ── Fixer Stats ────────────────────────────────────────────────────

  getFixRate24h(): number {
    const cutoff = Math.floor(Date.now() / 1000) - 86400;
    const row = this.db
      .prepare(
        `SELECT
           CASE WHEN COUNT(*)=0 THEN 0
             ELSE CAST(ROUND(100.0*SUM(CASE WHEN result='success' THEN 1 ELSE 0 END)/COUNT(*)) AS INTEGER)
           END as rate
         FROM fixer_stats WHERE epoch > ?`
      )
      .get(cutoff) as { rate: number };
    return row.rate;
  }

  // ── Counts ─────────────────────────────────────────────────────────

  countByStatus(status: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = ?")
      .get(status) as { cnt: number };
    return row.cnt;
  }

  countPending(): number {
    return this.countByStatus("pending");
  }

  // ── Cleanup helpers ────────────────────────────────────────────────

  /** Get branches for cleanup (fixed/superseded/blocked tasks). */
  getCleanupBranches(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT branch FROM tasks
         WHERE status IN ('fixed','superseded','blocked') AND branch != '' AND branch NOT LIKE 'merged%'`
      )
      .all() as { branch: string }[];
    return rows.map((r) => r.branch);
  }

  /** Get all task branches with their status (for CLI cleanup classification). */
  getTaskBranches(): { branch: string; status: string; title: string }[] {
    return this.db
      .prepare(
        `SELECT branch, status, title FROM tasks
         WHERE branch != ''
         ORDER BY updated_at DESC`
      )
      .all() as { branch: string; status: string; title: string }[];
  }

  // ── Export ─────────────────────────────────────────────────────────

  /** Export all tasks (for CLI export / backup). */
  exportAllTasks(): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY id")
      .all() as TaskRow[];
  }

  /** Export all blockers. */
  exportAllBlockers(): BlockerRow[] {
    return this.db
      .prepare("SELECT * FROM blockers ORDER BY id")
      .all() as BlockerRow[];
  }

  /** Export all events. */
  exportAllEvents(): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events ORDER BY id")
      .all() as EventRow[];
  }

  /** Export all fixer stats. */
  exportAllFixerStats(): FixerStatRow[] {
    return this.db
      .prepare("SELECT * FROM fixer_stats ORDER BY id")
      .all() as FixerStatRow[];
  }
}

// ─── Singleton factory ───────────────────────────────────────────────

let _instance: SkynetDB | null = null;

export function getSkynetDB(devDir: string): SkynetDB {
  if (!_instance) {
    _instance = new SkynetDB(`${devDir}/skynet.db`);
  }
  return _instance;
}
