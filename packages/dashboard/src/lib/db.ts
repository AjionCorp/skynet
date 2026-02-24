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
// NOTE: We use `as` type assertions for SQLite results because better-sqlite3's
// .all()/.get() return `unknown`. The row shapes match our CREATE TABLE schema
// which is controlled by db_init() in _db.sh. Runtime validation would add
// overhead with no practical benefit since the schema is deterministic.

export class SkynetDB {
  private db: Database;

  constructor(dbPath: string) {
    const Database = loadDriver();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
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
      .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status IN ('completed','fixed','done')")
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
      .slice(0, 120);

    // Wrap UPDATE + INSERT in a transaction so a failed INSERT cannot leave
    // priorities shifted without the new row (corrupting priority order).
    const insertAtTop = this.db.transaction(() => {
      this.db.prepare("UPDATE tasks SET priority=priority+1 WHERE status IN ('pending','claimed')").run();
      const info = this.db
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
      const info = this.db
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

  /** Get heartbeats for all workers. */
  getHeartbeats(maxWorkers: number): Record<string, { lastEpoch: number | null; ageMs: number | null; isStale: boolean }> {
    const staleMs = STALE_THRESHOLD_SECONDS * 1000;
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

  /**
   * Calculate pipeline health score (0-100) in a single query.
   * SQL implementation of the canonical formula in packages/dashboard/src/lib/health.ts.
   * Must stay in SQL for single-query efficiency. Keep weights in sync with:
   *   - packages/dashboard/src/handlers/pipeline-status.ts (calculateHealthScore)
   *   - packages/cli/src/commands/status.ts (healthScore calculation)
   *   - scripts/watchdog.sh (_health_score_alert)
   */
  calculateHealthScore(maxWorkers: number): number {
    const safeMax = Math.max(1, Math.min(maxWorkers, 100));
    const staleEpoch = Math.floor(Date.now() / 1000) - STALE_THRESHOLD_SECONDS;
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

  // ── Rate Limiting ────────────────────────────────────────────────────

  /** Ensure the rate_limits table exists (idempotent, runs once per instance). */
  private _rateLimitsTableCreated = false;
  private ensureRateLimitsTable(): void {
    if (this._rateLimitsTableCreated) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0,
        window_start INTEGER DEFAULT 0
      );
    `);
    this._rateLimitsTableCreated = true;
  }

  /**
   * Check whether a rate limit key has exceeded the allowed count within the window.
   * Returns true if the request is allowed, false if rate-limited.
   * On success, increments the counter atomically.
   */
  checkRateLimit(key: string, maxCount: number, windowMs: number): boolean {
    this.ensureRateLimitsTable();
    const nowMs = Date.now();
    const windowStartThreshold = nowMs - windowMs;

    const row = this.db
      .prepare("SELECT count, window_start FROM rate_limits WHERE key = ?")
      .get(key) as { count: number; window_start: number } | undefined;

    if (!row || row.window_start <= windowStartThreshold) {
      // No record or window expired — reset the window
      this.db
        .prepare(
          "INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)"
        )
        .run(key, nowMs);
      return true;
    }

    if (row.count >= maxCount) {
      return false;
    }

    // Increment within the current window
    this.db
      .prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?")
      .run(key);
    return true;
  }
}

// WARNING: Node.js fork() would inherit this file descriptor. If you add
// child_process.fork() consumers, close and reopen the connection in the child.

// ─── Singleton factory ───────────────────────────────────────────────
// Connection pooling is unnecessary here: the dashboard runs as a single
// Next.js server process with WAL-mode SQLite, so a single reused
// connection (with busy_timeout) is sufficient and avoids the complexity
// of pool management.

let _instance: SkynetDB | null = null;
let _instanceIno: bigint | number | null = null;
let _instancePath: string | null = null;

export function getSkynetDB(devDir: string): SkynetDB {
  const dbPath = `${devDir}/skynet.db`;
  // Check if the database file's inode has changed (e.g., restored from backup).
  // If so, close the stale connection and create a fresh one.
  if (_instance && _instancePath === dbPath) {
    try {
      const { statSync } = require("fs") as typeof import("fs");
      const currentIno = statSync(dbPath).ino;
      if (_instanceIno !== null && currentIno !== _instanceIno) {
        _instance.close();
        _instance = null;
        _instanceIno = null;
      }
    } catch {
      // File missing — let the constructor handle the error
    }
  }
  if (!_instance) {
    _instance = new SkynetDB(dbPath);
    _instancePath = dbPath;
    try {
      const { statSync } = require("fs") as typeof import("fs");
      _instanceIno = statSync(dbPath).ino;
    } catch {
      _instanceIno = null;
    }
  }
  return _instance;
}

process.on("exit", () => { _instance?.close(); _instance = null; });
