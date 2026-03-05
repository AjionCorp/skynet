import { statSync as fsStatSync } from "fs";
import type {
  BacklogItem,
  CompletedTask,
  FailedTask,
  EventEntry,
  SelfCorrectionStats,
} from "../types";
import { STALE_THRESHOLD_SECONDS } from "./constants";

// better-sqlite3 is a peer/optional dependency — handlers that call SkynetDB
// must ensure it's installed.  We use a lazy require so the rest of the package
// can still be imported in environments without the native addon.
type BetterSqlite3 = typeof import("better-sqlite3");
type Database = import("better-sqlite3").Database;

let _betterSqlite3: BetterSqlite3 | null = null;
// OPS-P3-3: Cache load failure so subsequent calls don't retry require() on
// every request. Once the native addon fails to load (e.g., missing binary),
// retrying on each request just wastes time and logs noise.
// TS-P3-3: Use a timestamp instead of boolean — retry after 5 minutes in case
// the issue was transient (e.g., native addon reinstalled).
let _loadFailedAt = 0;
const LOAD_RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
function loadDriver(): BetterSqlite3 {
  if (_loadFailedAt > 0 && (Date.now() - _loadFailedAt) < LOAD_RETRY_INTERVAL_MS) {
    throw new Error("better-sqlite3 previously failed to load — skipping retry (will retry after 5min)");
  }
  if (!_betterSqlite3) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      // require() is synchronous but only executes once (Node caches modules).
      // The native addon load time is ~5ms on first require. Switching to dynamic
      // import() would require making the constructor async, adding complexity
      // for negligible benefit in a server-side context.
      _betterSqlite3 = require("better-sqlite3") as BetterSqlite3;
      _loadFailedAt = 0; // Reset on successful load
    } catch (err) {
      _loadFailedAt = Date.now();
      throw err;
    }
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
  reason_code: string;
  files_touched: string;
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
// NOTE: We use `as` type assertions for SQLite results because better-sqlite3's
// .all()/.get() return `unknown`. The row shapes match our CREATE TABLE schema
// which is controlled by db_init() in _db.sh. Runtime validation would add
// overhead with no practical benefit since the schema is deterministic.

/**
 * SkynetDB wraps better-sqlite3 for dashboard queries.
 *
 * Rate limiting is handled by the in-memory sliding-window limiter in
 * `rate-limiter.ts`, so read-only consumers can open the database with
 * `{ readonly: true }` to avoid write contention.
 */
export class SkynetDB {
  private db: Database;
  private hasMissionHash: boolean;

  constructor(dbPath: string, opts?: { readonly?: boolean }) {
    const Database = loadDriver();
    this.db = new Database(dbPath, opts?.readonly ? { readonly: true } : undefined);
    // Set busy_timeout first so that the journal_mode = WAL pragma does not
    // fail with SQLITE_BUSY if another process holds the database lock.
    this.db.pragma("busy_timeout = 15000");
    if (!opts?.readonly) {
      this.db.pragma("journal_mode = WAL");
    }
    this.db.pragma("foreign_keys = ON");
    // OPS-P2-8: Verify SQLite version supports CTEs (requires >= 3.8.3)
    // Parse into numeric components — string comparison is lexicographic and
    // would incorrectly rank "3.10.0" < "3.8.3".
    const version = this.db.pragma("sqlite_version", { simple: true }) as string | undefined;
    if (version) {
      const [major, minor, patch] = version.split(".").map(Number);
      if (
        major < 3 ||
        (major === 3 && minor < 8) ||
        (major === 3 && minor === 8 && patch < 3)
      ) {
        this.db.close();
        throw new Error(`SQLite ${version} is too old — requires >= 3.8.3 for CTE support`);
      }
    }
    // Lightweight call that only runs ANALYZE when statistics are stale.
    // Safe to call on every connection — no-op when stats are fresh.
    this.db.pragma("optimize");

    // Detect optional columns (schema migrations add mission_hash).
    const cols = this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    this.hasMissionHash = cols.some((c) => c.name === "mission_hash");
  }

  close(): void {
    this.db.close();
  }

  // ── Backlog / Tasks ────────────────────────────────────────────────

  /** Returns backlog items matching the dashboard shape. */
  getBacklogItems(missionHash = ""): {
    items: BacklogItem[];
    pendingCount: number;
    claimedCount: number;
    manualDoneCount: number;
  } {
    const missionFilter =
      this.hasMissionHash && missionHash
        ? " AND mission_hash = ?"
        : "";
    const rows = this.db
      .prepare(
        `SELECT id, title, tag, description, status, blocked_by, priority
         FROM tasks
         WHERE status IN ('pending','claimed')${missionFilter}
         ORDER BY priority ASC`
      )
      .all(...(missionFilter ? [missionHash] : [])) as Pick<TaskRow, "id" | "title" | "tag" | "description" | "status" | "blocked_by" | "priority">[];

    // Compute manualDoneCount separately — these rows are not needed for backlog display
    const doneRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tasks WHERE status='done'${missionFilter}`
      )
      .get(...(missionFilter ? [missionHash] : [])) as { cnt: number } | undefined;
    const manualDoneCount = doneRow?.cnt ?? 0;

    // Build title→status map for blocked resolution (include done items for dependency checks)
    const titleToStatus = new Map<string, string>();
    for (const r of rows) titleToStatus.set(r.title, r.status);
    // Also load done titles so blockedBy resolution can find them
    const doneRows = this.db
      .prepare(`SELECT title FROM tasks WHERE status='done'${missionFilter}`)
      .all(...(missionFilter ? [missionHash] : [])) as Pick<TaskRow, "title">[];
    for (const r of doneRows) titleToStatus.set(r.title, "done");

    let pendingCount = 0;
    let claimedCount = 0;

    const items: BacklogItem[] = rows.map((r) => {
      const status = r.status as "pending" | "claimed";
      if (status === "pending") pendingCount++;
      else if (status === "claimed") claimedCount++;

      const blockedBy = r.blocked_by
        ? r.blocked_by.split(",").map((s) => s.trim().replace(/`/g, "")).filter(Boolean)
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

    return { items, pendingCount, claimedCount, manualDoneCount };
  }

  /** Completed tasks (most recent first). */
  getCompletedTasks(limit = 50, missionHash = ""): CompletedTask[] {
    const missionFilter =
      this.hasMissionHash && missionHash
        ? " AND mission_hash = ?"
        : "";
    const rows = this.db
      .prepare(
        `SELECT completed_at, title, branch, duration, notes, files_touched
         FROM tasks
         WHERE status IN ('completed','fixed')${missionFilter}
         ORDER BY completed_at DESC
         LIMIT ?`
      )
      .all(...(missionFilter ? [missionHash, limit] : [limit])) as Pick<TaskRow, "completed_at" | "title" | "branch" | "duration" | "notes" | "files_touched">[];

    return rows.map((r) => ({
      date: r.completed_at ? r.completed_at.slice(0, 10) : "",
      task: r.title,
      branch: r.branch ?? "",
      duration: r.duration ?? "",
      notes: r.notes ?? "",
      filesTouched: r.files_touched ?? "",
    }));
  }

  getCompletedCount(missionHash = ""): number {
    const missionFilter =
      this.hasMissionHash && missionHash
        ? " AND mission_hash = ?"
        : "";
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE status IN ('completed','fixed','done')${missionFilter}`)
      .get(...(missionFilter ? [missionHash] : [])) as { cnt: number };
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
  getFailedTasks(missionHash = ""): FailedTask[] {
    const missionFilter =
      this.hasMissionHash && missionHash
        ? " AND mission_hash = ?"
        : "";
    const rows = this.db
      .prepare(
        `SELECT failed_at, title, branch, error, attempts, status, reason_code, files_touched
         FROM tasks
         WHERE (status IN ('failed','blocked','fixed','superseded')
            OR status LIKE 'fixing-%')${missionFilter}
         ORDER BY failed_at DESC`
      )
      .all(...(missionFilter ? [missionHash] : [])) as Pick<TaskRow, "failed_at" | "title" | "branch" | "error" | "attempts" | "status" | "reason_code" | "files_touched">[];

    return rows.map((r) => ({
      date: r.failed_at ? r.failed_at.slice(0, 10) : "",
      task: r.title,
      branch: r.branch ?? "",
      error: r.error ?? "",
      attempts: String(r.attempts ?? 0),
      status: r.status,
      outcomeReason: r.reason_code ?? "",
      filesTouched: r.files_touched ?? "",
    }));
  }

  /** Failed tasks with worker_id for failure analysis. */
  getFailedTasksWithWorker(missionHash = ""): Array<{
    date: string;
    task: string;
    branch: string;
    error: string;
    attempts: number;
    status: string;
    workerId: number | null;
  }> {
    const missionFilter =
      this.hasMissionHash && missionHash
        ? " AND mission_hash = ?"
        : "";
    const rows = this.db
      .prepare(
        `SELECT failed_at, title, branch, error, attempts, status, worker_id
         FROM tasks
         WHERE (status IN ('failed','blocked','fixed','superseded')
            OR status LIKE 'fixing-%')${missionFilter}
         ORDER BY failed_at DESC`
      )
      .all(...(missionFilter ? [missionHash] : [])) as Pick<TaskRow, "failed_at" | "title" | "branch" | "error" | "attempts" | "status" | "worker_id">[];

    return rows.map((r) => ({
      date: r.failed_at ? r.failed_at.slice(0, 10) : "",
      task: r.title,
      branch: r.branch ?? "",
      error: r.error ?? "",
      attempts: r.attempts ?? 0,
      status: r.status,
      workerId: r.worker_id,
    }));
  }

  /** Self-correction breakdown. */
  getSelfCorrectionStats(missionHash = ""): SelfCorrectionStats {
    const missionFilter =
      this.hasMissionHash && missionHash
        ? " AND mission_hash = ?"
        : "";
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) as cnt
         FROM tasks
         WHERE (status IN ('failed','blocked','fixed','superseded')
            OR status LIKE 'fixing-%')${missionFilter}
         GROUP BY status`
      )
      .all(...(missionFilter ? [missionHash] : [])) as { status: string; cnt: number }[];

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
    blockedBy = "",
    missionHash = ""
  ): number {
    const normalizedRoot = title
      .replace(/\[[A-Z]*\]\s*/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);

    // Wrap UPDATE + INSERT in a transaction so a failed INSERT cannot leave
    // priorities shifted without the new row (corrupting priority order).
    const insertAtTop = this.db.transaction(() => {
      this.db.prepare("UPDATE tasks SET priority=priority+1 WHERE status IN ('pending','claimed')").run();
      const info = this.hasMissionHash
        ? this.db
            .prepare(
              `INSERT INTO tasks (title, tag, description, status, blocked_by, normalized_root, priority, mission_hash)
               VALUES (?, ?, ?, 'pending', ?, ?, 0, ?)`
            )
            .run(title, tag, description, blockedBy, normalizedRoot, missionHash)
        : this.db
            .prepare(
              `INSERT INTO tasks (title, tag, description, status, blocked_by, normalized_root, priority)
               VALUES (?, ?, ?, 'pending', ?, ?, 0)`
            )
            .run(title, tag, description, blockedBy, normalizedRoot);
      return Number(info.lastInsertRowid);
    });

    const insertAtBottom = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(priority),0)+1 as next FROM tasks WHERE status IN ('pending','claimed')")
        .get() as { next: number };
      const info = this.hasMissionHash
        ? this.db
            .prepare(
              `INSERT INTO tasks (title, tag, description, status, blocked_by, normalized_root, priority, mission_hash)
               VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
            )
            .run(title, tag, description, blockedBy, normalizedRoot, row.next, missionHash)
        : this.db
            .prepare(
              `INSERT INTO tasks (title, tag, description, status, blocked_by, normalized_root, priority)
               VALUES (?, ?, ?, 'pending', ?, ?, ?)`
            )
            .run(title, tag, description, blockedBy, normalizedRoot, row.next);
      return Number(info.lastInsertRowid);
    });

    return position === "top" ? insertAtTop() : insertAtBottom();
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

  /** Get all workers' current tasks (single query instead of per-worker). */
  getAllCurrentTasks(maxWorkers: number): Record<string, ReturnType<SkynetDB["getCurrentTask"]>> {
    const result: Record<string, ReturnType<SkynetDB["getCurrentTask"]>> = {};
    const rows = this.db
      .prepare("SELECT * FROM workers WHERE id <= ? ORDER BY id")
      .all(maxWorkers) as WorkerRow[];

    for (const row of rows) {
      result[`worker-${row.id}`] = {
        status: row.status,
        title: row.task_title || null,
        branch: row.branch || null,
        started: row.started_at,
        worker: `Worker ${row.id}`,
        lastInfo: row.last_info || null,
      };
    }
    return result;
  }

  /** Get heartbeats for all workers.
   *  @param staleMinutes — optional override for the stale threshold (in minutes).
   *    Falls back to the module-level STALE_THRESHOLD_SECONDS when not provided. */
  getHeartbeats(maxWorkers: number, staleMinutes?: number): Record<string, { lastEpoch: number | null; ageMs: number | null; isStale: boolean }> {
    const staleMs = staleMinutes != null
      ? staleMinutes * 60 * 1000
      : STALE_THRESHOLD_SECONDS * 1000;
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

  /** Get all workers' intent data (status, task, heartbeat, progress). */
  getWorkerIntents(): Array<{
    workerId: number;
    workerType: string;
    status: string;
    taskId: number | null;
    taskTitle: string | null;
    branch: string | null;
    startedAt: string | null;
    heartbeatEpoch: number | null;
    progressEpoch: number | null;
    lastInfo: string | null;
    updatedAt: string;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM workers ORDER BY id")
      .all() as (WorkerRow & { progress_epoch?: number | null })[];

    return rows.map((row) => ({
      workerId: row.id,
      workerType: row.worker_type,
      status: row.status,
      taskId: row.current_task_id,
      taskTitle: row.task_title || null,
      branch: row.branch || null,
      startedAt: row.started_at,
      heartbeatEpoch: row.heartbeat_epoch,
      progressEpoch: row.progress_epoch ?? null,
      lastInfo: row.last_info || null,
      updatedAt: row.updated_at,
    }));
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

  /**
   * Calculate pipeline health score (0-100) in a single query.
   * SQL implementation of the canonical formula in packages/dashboard/src/lib/health.ts.
   * Must stay in SQL for single-query efficiency. Keep weights in sync with:
   *   - packages/dashboard/src/handlers/pipeline-status.ts (calculateHealthScore)
   *   - packages/cli/src/commands/status.ts (healthScore calculation)
   *   - scripts/watchdog.sh (_health_score_alert)
   */
  calculateHealthScore(maxWorkers: number, staleMinutes?: number): number {
    const safeMax = Math.max(1, Math.min(maxWorkers, 100));
    const staleSeconds = staleMinutes != null ? staleMinutes * 60 : STALE_THRESHOLD_SECONDS;
    const staleEpoch = Math.floor(Date.now() / 1000) - staleSeconds;
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM tasks WHERE status='failed') as failed_count,
           (SELECT COUNT(*) FROM blockers WHERE status='active') as blocker_count,
           (SELECT COUNT(*) FROM workers WHERE id <= ? AND heartbeat_epoch IS NOT NULL
              AND heartbeat_epoch > 0 AND heartbeat_epoch < ?) as stale_hb_count,
           (SELECT COUNT(*) FROM workers WHERE status='in_progress' AND started_at IS NOT NULL
              AND (julianday('now')-julianday(started_at))>1) as stale_task_count`
      )
      .get(safeMax, staleEpoch) as {
        failed_count: number;
        blocker_count: number;
        stale_hb_count: number;
        stale_task_count: number;
      };

    const score = 100 - row.failed_count * 5 - row.blocker_count * 10 - row.stale_hb_count * 2 - row.stale_task_count;
    return Math.max(0, Math.min(100, score));
  }

  /** Count workers currently in_progress. */
  countActiveWorkers(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM workers WHERE status = 'in_progress'")
      .get() as { cnt: number };
    return row.cnt;
  }

  /** Count total events recorded. */
  countEvents(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM events")
      .get() as { cnt: number };
    return row.cnt;
  }

  // ── Worker Performance Stats ────────────────────────────────────────

  /** Per-worker performance stats (completed, failed, avg duration, success rate, tag breakdown). */
  getWorkerPerformanceStats(maxWorkers: number): Record<string, { completedCount: number; failedCount: number; avgDuration: string | null; successRate: number; tagBreakdown: Record<string, number> }> {
    const rows = this.db
      .prepare(
        `SELECT
           worker_id,
           SUM(CASE WHEN status IN ('completed','fixed') THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status IN ('failed','blocked','superseded') OR status LIKE 'fixing-%' THEN 1 ELSE 0 END) as failed,
           AVG(CASE WHEN status IN ('completed','fixed') AND duration_secs > 0 THEN duration_secs ELSE NULL END) as avg_secs
         FROM tasks
         WHERE worker_id IS NOT NULL AND worker_id <= ?
         GROUP BY worker_id`
      )
      .all(maxWorkers) as { worker_id: number; completed: number; failed: number; avg_secs: number | null }[];

    // Per-worker tag breakdown (completed + fixed tasks only)
    const tagRows = this.db
      .prepare(
        `SELECT worker_id, tag, COUNT(*) as cnt
         FROM tasks
         WHERE worker_id IS NOT NULL AND worker_id <= ?
           AND status IN ('completed','fixed')
           AND tag IS NOT NULL
         GROUP BY worker_id, tag`
      )
      .all(maxWorkers) as { worker_id: number; tag: string; cnt: number }[];

    const tagMap: Record<number, Record<string, number>> = {};
    for (const t of tagRows) {
      if (!tagMap[t.worker_id]) tagMap[t.worker_id] = {};
      tagMap[t.worker_id][t.tag] = t.cnt;
    }

    const result: Record<string, { completedCount: number; failedCount: number; avgDuration: string | null; successRate: number; tagBreakdown: Record<string, number> }> = {};

    // Initialize all workers with zeros
    for (let wid = 1; wid <= maxWorkers; wid++) {
      result[`worker-${wid}`] = { completedCount: 0, failedCount: 0, avgDuration: null, successRate: 0, tagBreakdown: {} };
    }

    for (const r of rows) {
      const total = r.completed + r.failed;
      let avgDuration: string | null = null;
      if (r.avg_secs != null && r.avg_secs > 0) {
        const minutes = r.avg_secs / 60;
        if (minutes < 60) {
          avgDuration = `${Math.round(minutes)}m`;
        } else {
          const h = Math.floor(minutes / 60);
          const rem = Math.round(minutes % 60);
          avgDuration = rem === 0 ? `${h}h` : `${h}h ${rem}m`;
        }
      }
      result[`worker-${r.worker_id}`] = {
        completedCount: r.completed,
        failedCount: r.failed,
        avgDuration,
        successRate: total > 0 ? Math.round((r.completed / total) * 100) : 0,
        tagBreakdown: tagMap[r.worker_id] || {},
      };
    }

    return result;
  }

  /** Per-worker task-type affinity: success rates broken down by tag. */
  getWorkerTaskTypeAffinity(maxWorkers: number): Record<string, { tag: string; completed: number; failed: number; successRate: number }[]> {
    const rows = this.db
      .prepare(
        `SELECT
           worker_id,
           tag,
           SUM(CASE WHEN status IN ('completed','fixed') THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status IN ('failed','blocked','superseded') OR status LIKE 'fixing-%' THEN 1 ELSE 0 END) as failed
         FROM tasks
         WHERE worker_id IS NOT NULL AND worker_id <= ? AND tag != ''
         GROUP BY worker_id, tag`
      )
      .all(maxWorkers) as { worker_id: number; tag: string; completed: number; failed: number }[];

    const result: Record<string, { tag: string; completed: number; failed: number; successRate: number }[]> = {};
    for (let wid = 1; wid <= maxWorkers; wid++) {
      result[`worker-${wid}`] = [];
    }

    for (const r of rows) {
      const total = r.completed + r.failed;
      result[`worker-${r.worker_id}`]?.push({
        tag: r.tag,
        completed: r.completed,
        failed: r.failed,
        successRate: total > 0 ? Math.round((r.completed / total) * 100) : 0,
      });
    }

    // Sort each worker's affinities by total tasks descending
    for (const key of Object.keys(result)) {
      result[key].sort((a, b) => (b.completed + b.failed) - (a.completed + a.failed));
    }

    return result;
  }

  /** Per-worker contribution breakdown: completed/failed counts, avg duration, recent task titles. */
  getWorkerContributions(maxWorkers: number): { workerId: number; completed: number; failed: number; avgSecs: number | null; recentTasks: string[] }[] {
    const statsRows = this.db
      .prepare(
        `SELECT
           worker_id,
           SUM(CASE WHEN status IN ('completed','fixed') THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status IN ('failed','blocked','superseded') OR status LIKE 'fixing-%' THEN 1 ELSE 0 END) as failed,
           AVG(CASE WHEN status IN ('completed','fixed') AND duration_secs > 0 THEN duration_secs ELSE NULL END) as avg_secs
         FROM tasks
         WHERE worker_id IS NOT NULL AND worker_id <= ?
         GROUP BY worker_id`
      )
      .all(maxWorkers) as { worker_id: number; completed: number; failed: number; avg_secs: number | null }[];

    const results: { workerId: number; completed: number; failed: number; avgSecs: number | null; recentTasks: string[] }[] = [];

    for (const r of statsRows) {
      if (r.completed === 0 && r.failed === 0) continue;
      // Fetch last 5 completed task titles for this worker
      const taskRows = this.db
        .prepare(
          `SELECT title FROM tasks
           WHERE worker_id = ? AND status IN ('completed','fixed')
           ORDER BY completed_at DESC LIMIT 5`
        )
        .all(r.worker_id) as { title: string }[];

      results.push({
        workerId: r.worker_id,
        completed: r.completed,
        failed: r.failed,
        avgSecs: r.avg_secs,
        recentTasks: taskRows.map((t) => t.title),
      });
    }

    return results;
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

  /** Archive (delete) resolved failed tasks older than N days. Returns count deleted. */
  archiveResolvedFailures(days = 7): number {
    const result = this.db
      .prepare(
        `DELETE FROM tasks
         WHERE status IN ('fixed','superseded','blocked')
           AND updated_at < datetime('now', '-' || ? || ' days')`
      )
      .run(days);
    return result.changes;
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

  /** Regenerate backlog.md from SQLite (authoritative source). */
  exportBacklog(backlogPath: string): void {
    const { writeFileSync, renameSync } = require("fs") as typeof import("fs");

    const pending = this.db
      .prepare(
        `SELECT tag, title, description, status, blocked_by FROM tasks
         WHERE status IN ('pending','claimed')
         ORDER BY priority ASC`
      )
      .all() as { tag: string; title: string; description: string; status: string; blocked_by: string }[];

    const done = this.db
      .prepare(
        `SELECT tag, title, description, blocked_by, notes FROM tasks
         WHERE status = 'done'
         ORDER BY updated_at DESC LIMIT 30`
      )
      .all() as { tag: string; title: string; description: string; blocked_by: string; notes: string }[];

    const lines: string[] = [
      "# Backlog",
      "",
      "<!-- Priority: top = highest. Format: - [ ] [TAG] Task title \u2014 description -->",
      "<!-- Markers: [ ] = pending, [>] = claimed by worker, [x] = done -->",
      "",
    ];

    for (const row of pending) {
      const marker = row.status === "claimed" ? ">" : " ";
      let line = `- [${marker}] [${row.tag}] ${row.title}`;
      if (row.description) line += ` \u2014 ${row.description}`;
      if (row.blocked_by) line += ` | blockedBy: ${row.blocked_by}`;
      lines.push(line);
    }

    if (done.length > 0) {
      lines.push("# Recent checked history (last 30)");
      for (const row of done) {
        let line = `- [x] [${row.tag}] ${row.title}`;
        if (row.description) line += ` \u2014 ${row.description}`;
        if (row.notes && row.notes !== "success") line += ` _(${row.notes})_`;
        lines.push(line);
      }
    }

    const tmpPath = backlogPath + ".tmp";
    writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
    // renameSync is atomic on the same filesystem. tmpPath is in the same directory
    // as backlogPath, so cross-filesystem rename failure cannot occur here.
    renameSync(tmpPath, backlogPath);
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

// WARNING: Node.js fork() would inherit this file descriptor. If you add
// child_process.fork() consumers, close and reopen the connection in the child.

// ─── Singleton factory ───────────────────────────────────────────────
// OPS-P2-4: Connection pooling is intentionally not used. SQLite in WAL mode
// supports concurrent readers but only a single writer. Since the dashboard is a
// single Next.js process, a pooled set of connections would not improve throughput —
// writes are serialized by SQLite regardless. The busy_timeout pragma (15s) handles
// write contention by retrying internally, which is more efficient than application-
// level pool management. If this were PostgreSQL or MySQL, a pool would be warranted;
// for SQLite, a single reused connection is both simpler and optimal.

let _instance: SkynetDB | null = null;
let _instanceIno: bigint | number | null = null;
let _instancePath: string | null = null;

// Separate readonly singleton — never interferes with the read-write
// connection's WAL writer lock. Safe in SQLite WAL mode where concurrent
// readers are fully supported alongside a single writer.
let _roInstance: SkynetDB | null = null;
let _roInstanceIno: bigint | number | null = null;
let _roInstancePath: string | null = null;

/** Invalidate a cached instance if its dbPath or inode changed. */
function _validateCached(
  inst: SkynetDB | null,
  path: string | null,
  ino: bigint | number | null,
  dbPath: string,
): { stale: boolean } {
  if (inst && path !== dbPath) return { stale: true };
  if (inst && path === dbPath) {
    try {
      const currentIno = fsStatSync(dbPath).ino;
      if (ino !== null && currentIno !== ino) return { stale: true };
    } catch {
      // File missing — let the constructor handle the error
    }
  }
  return { stale: false };
}

export function getSkynetDB(devDir: string, opts?: { readonly?: boolean }): SkynetDB {
  const dbPath = `${devDir}/skynet.db`;

  if (opts?.readonly) {
    if (_validateCached(_roInstance, _roInstancePath, _roInstanceIno, dbPath).stale) {
      _roInstance!.close();
      _roInstance = null;
      _roInstanceIno = null;
    }
    if (!_roInstance) {
      _roInstance = new SkynetDB(dbPath, { readonly: true });
      _roInstancePath = dbPath;
      try { _roInstanceIno = fsStatSync(dbPath).ino; } catch { _roInstanceIno = null; }
    }
    return _roInstance;
  }

  // SINGLETON LIMITATION: This factory caches a single SkynetDB instance keyed
  // by dbPath. If multiple devDirs are used in the same process (e.g., a future
  // multi-project dashboard), only the first-opened connection is cached — calls
  // with a different devDir will create a new instance but the old one remains
  // cached. For multi-devDir support, this would need a Map<string, SkynetDB>.
  // Currently the dashboard only serves one project at a time, so this is safe.
  if (_validateCached(_instance, _instancePath, _instanceIno, dbPath).stale) {
    _instance!.close();
    _instance = null;
    _instanceIno = null;
  }
  if (!_instance) {
    _instance = new SkynetDB(dbPath);
    _instancePath = dbPath;
    try {
      _instanceIno = fsStatSync(dbPath).ino;
    } catch {
      _instanceIno = null;
    }
  }
  return _instance;
}

process.on("exit", () => {
  _instance?.close(); _instance = null;
  _roInstance?.close(); _roInstance = null;
});

/** @internal — Reset singleton for tests only. */
export function _resetSingleton() {
  if (_instance) { _instance.close(); }
  _instance = null;
  _instancePath = null;
  _instanceIno = null;
  if (_roInstance) { _roInstance.close(); }
  _roInstance = null;
  _roInstancePath = null;
  _roInstanceIno = null;
}
