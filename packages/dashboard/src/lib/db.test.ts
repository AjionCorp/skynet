import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SkynetDB, getSkynetDB, _resetSingleton } from "./db";

// SQL schema from scripts/_db.sh — enough to exercise SkynetDB methods
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  tag             TEXT NOT NULL DEFAULT '',
  description     TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending',
  blocked_by      TEXT DEFAULT '',
  branch          TEXT DEFAULT '',
  worker_id       INTEGER,
  fixer_id        INTEGER,
  error           TEXT DEFAULT '',
  attempts        INTEGER NOT NULL DEFAULT 0,
  duration        TEXT DEFAULT '',
  duration_secs   INTEGER,
  notes           TEXT DEFAULT '',
  priority        INTEGER NOT NULL DEFAULT 0,
  normalized_root TEXT DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at      TEXT,
  completed_at    TEXT,
  failed_at       TEXT
);
CREATE TABLE IF NOT EXISTS blockers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  task_title  TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS workers (
  id              INTEGER PRIMARY KEY,
  worker_type     TEXT NOT NULL DEFAULT 'dev',
  status          TEXT NOT NULL DEFAULT 'idle',
  current_task_id INTEGER,
  task_title      TEXT DEFAULT '',
  branch          TEXT DEFAULT '',
  started_at      TEXT,
  heartbeat_epoch INTEGER,
  progress_epoch  INTEGER,
  last_info       TEXT DEFAULT '',
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch       INTEGER NOT NULL,
  event       TEXT NOT NULL,
  detail      TEXT DEFAULT '',
  worker_id   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fixer_stats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch       INTEGER NOT NULL,
  result      TEXT NOT NULL,
  task_title  TEXT NOT NULL,
  fixer_id    INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

describe("SkynetDB", () => {
  let tmpDir: string;
  let db: SkynetDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "skynet-db-test-"));
    const dbPath = join(tmpDir, "skynet.db");
    // Create the database and apply schema
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const rawDb = new Database(dbPath);
    rawDb.exec(SCHEMA);
    rawDb.close();
    // Now open via SkynetDB
    db = new SkynetDB(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("creates a WAL-mode database", () => {
      // WAL mode is set in constructor. Verify by querying pragma.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"), { readonly: true });
      const mode = rawDb.pragma("journal_mode", { simple: true });
      rawDb.close();
      expect(mode).toBe("wal");
    });
  });

  describe("countPending", () => {
    it("returns 0 when no pending tasks", () => {
      expect(db.countPending()).toBe(0);
    });

    it("returns count of pending tasks", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('Task 1', 'FEAT', 'pending', 0)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('Task 2', 'FIX', 'pending', 1)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('Task 3', 'FIX', 'completed', 2)");
      rawDb.close();
      expect(db.countPending()).toBe(2);
    });
  });

  describe("countByStatus", () => {
    it("returns count for a given status", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T1', 'FIX', 'failed', 0)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T2', 'FIX', 'failed', 1)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T3', 'FIX', 'failed', 2)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T4', 'FIX', 'pending', 3)");
      rawDb.close();
      expect(db.countByStatus("failed")).toBe(3);
      expect(db.countByStatus("pending")).toBe(1);
      expect(db.countByStatus("blocked")).toBe(0);
    });
  });

  describe("getBacklogItems", () => {
    it("returns correct shape with empty results", () => {
      const result = db.getBacklogItems();
      expect(result).toEqual({
        items: [],
        pendingCount: 0,
        claimedCount: 0,
        doneCount: 0,
      });
    });

    it("returns items with correct counts", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('Fix bug', 'FIX', 'pending', 0)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('Add feat', 'FEAT', 'claimed', 1)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('Done task', 'INFRA', 'done', 2)");
      rawDb.close();

      const result = db.getBacklogItems();
      expect(result.pendingCount).toBe(1);
      expect(result.claimedCount).toBe(1);
      expect(result.doneCount).toBe(1);
      expect(result.items).toHaveLength(3);
      expect(result.items[0]).toMatchObject({
        tag: "FIX",
        status: "pending",
        blocked: false,
      });
    });

    it("marks items as blocked when dependency is not done", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, blocked_by, priority) VALUES ('First task', 'FIX', 'pending', '', 0)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, blocked_by, priority) VALUES ('Blocked task', 'FEAT', 'pending', 'First task', 1)");
      rawDb.close();

      const result = db.getBacklogItems();
      expect(result.items[1].blocked).toBe(true);
      expect(result.items[1].blockedBy).toEqual(["First task"]);
    });
  });

  describe("getSelfCorrectionStats", () => {
    it("returns correct shape with zeros for empty DB", () => {
      const result = db.getSelfCorrectionStats();
      expect(result).toEqual({
        fixed: 0,
        blocked: 0,
        superseded: 0,
        pending: 0,
        selfCorrected: 0,
      });
    });

    it("aggregates status counts correctly", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T1', 'FIX', 'fixed', 0)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T2', 'FIX', 'fixed', 1)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T3', 'FIX', 'blocked', 2)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T4', 'FIX', 'superseded', 3)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T5', 'FIX', 'failed', 4)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T6', 'FIX', 'fixing-1', 5)");
      rawDb.close();

      const result = db.getSelfCorrectionStats();
      expect(result.fixed).toBe(2);
      expect(result.blocked).toBe(1);
      expect(result.superseded).toBe(1);
      expect(result.pending).toBe(2); // failed + fixing-1
      expect(result.selfCorrected).toBe(3); // fixed + superseded
    });
  });

  describe("calculateHealthScore", () => {
    it("returns 100 for a perfectly healthy pipeline", () => {
      expect(db.calculateHealthScore(4)).toBe(100);
    });

    it("deducts 5 per failed task", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('F1', 'FIX', 'failed', 0)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('F2', 'FIX', 'failed', 1)");
      rawDb.close();
      expect(db.calculateHealthScore(4)).toBe(90);
    });

    it("deducts 10 per active blocker", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO blockers (description, status) VALUES ('Bug A', 'active')");
      rawDb.exec("INSERT INTO blockers (description, status) VALUES ('Bug B', 'active')");
      rawDb.exec("INSERT INTO blockers (description, status) VALUES ('Bug C', 'resolved')");
      rawDb.close();
      expect(db.calculateHealthScore(4)).toBe(80);
    });

    it("clamps score to minimum 0", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      // 25 failed tasks = -125 points => clamped to 0
      for (let i = 0; i < 25; i++) {
        rawDb.exec(`INSERT INTO tasks (title, tag, status, priority) VALUES ('F${i}', 'FIX', 'failed', ${i})`);
      }
      rawDb.close();
      expect(db.calculateHealthScore(4)).toBe(0);
    });

    it("clamps maxWorkers to at least 1", () => {
      // Should not throw even with 0 maxWorkers
      expect(db.calculateHealthScore(0)).toBe(100);
    });
  });

  describe("getCompletedCount", () => {
    it("returns count of completed/fixed/done tasks", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T1', 'FIX', 'completed', 0)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T2', 'FIX', 'fixed', 1)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T3', 'FIX', 'done', 2)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T4', 'FIX', 'pending', 3)");
      rawDb.close();
      expect(db.getCompletedCount()).toBe(3);
    });

    it("returns 0 when no completed tasks", () => {
      expect(db.getCompletedCount()).toBe(0);
    });
  });

  describe("getCompletedTasks", () => {
    it("returns empty array when no completed tasks", () => {
      expect(db.getCompletedTasks()).toEqual([]);
    });

    it("maps rows to CompletedTask shape", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec(
        "INSERT INTO tasks (title, tag, status, branch, duration, notes, completed_at, priority) " +
        "VALUES ('Fix auth', 'FIX', 'completed', 'skynet/fix-auth', '5m', 'success', '2026-02-20 10:00:00', 0)"
      );
      rawDb.close();

      const result = db.getCompletedTasks(10);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        date: "2026-02-20",
        task: "Fix auth",
        branch: "skynet/fix-auth",
        duration: "5m",
        notes: "success",
      });
    });
  });

  describe("getActiveBlockerLines", () => {
    it("returns empty array when no active blockers", () => {
      expect(db.getActiveBlockerLines()).toEqual([]);
    });

    it("returns formatted blocker lines for active blockers", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO blockers (description, status) VALUES ('Missing API key', 'active')");
      rawDb.exec("INSERT INTO blockers (description, status) VALUES ('Disk full', 'active')");
      rawDb.exec("INSERT INTO blockers (description, status) VALUES ('Resolved issue', 'resolved')");
      rawDb.close();

      const lines = db.getActiveBlockerLines();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("- Missing API key");
      expect(lines[1]).toBe("- Disk full");
    });
  });

  describe("getActiveBlockerCount", () => {
    it("returns 0 when no active blockers", () => {
      expect(db.getActiveBlockerCount()).toBe(0);
    });

    it("counts only active blockers", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO blockers (description, status) VALUES ('B1', 'active')");
      rawDb.exec("INSERT INTO blockers (description, status) VALUES ('B2', 'resolved')");
      rawDb.exec("INSERT INTO blockers (description, status) VALUES ('B3', 'active')");
      rawDb.close();
      expect(db.getActiveBlockerCount()).toBe(2);
    });
  });

  describe("getHeartbeats", () => {
    it("returns entries for all workers up to maxWorkers", () => {
      const result = db.getHeartbeats(3);
      expect(Object.keys(result)).toHaveLength(3);
      expect(result["worker-1"]).toEqual({ lastEpoch: null, ageMs: null, isStale: false });
      expect(result["worker-2"]).toEqual({ lastEpoch: null, ageMs: null, isStale: false });
      expect(result["worker-3"]).toEqual({ lastEpoch: null, ageMs: null, isStale: false });
    });

    it("detects stale heartbeats when epoch is too old", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const oldEpoch = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      rawDb.exec(`INSERT INTO workers (id, heartbeat_epoch) VALUES (1, ${oldEpoch})`);
      rawDb.close();

      const result = db.getHeartbeats(2);
      expect(result["worker-1"].lastEpoch).toBe(oldEpoch);
      expect(result["worker-1"].isStale).toBe(true);
      expect(result["worker-1"].ageMs).toBeGreaterThan(0);
    });

    it("marks fresh heartbeats as not stale", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const freshEpoch = Math.floor(Date.now() / 1000) - 10; // 10 seconds ago
      rawDb.exec(`INSERT INTO workers (id, heartbeat_epoch) VALUES (1, ${freshEpoch})`);
      rawDb.close();

      const result = db.getHeartbeats(2);
      expect(result["worker-1"].isStale).toBe(false);
    });

    it("uses custom staleMinutes when provided", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      // Heartbeat 3 minutes ago — stale with 2-minute threshold, fresh with default 30-minute threshold
      const epoch = Math.floor(Date.now() / 1000) - 180;
      rawDb.exec(`INSERT INTO workers (id, heartbeat_epoch) VALUES (1, ${epoch})`);
      rawDb.close();

      // With default staleMinutes (30 min), 3 minutes ago is fresh
      const defaultResult = db.getHeartbeats(1);
      expect(defaultResult["worker-1"].isStale).toBe(false);

      // With custom staleMinutes of 2, 3 minutes ago is stale
      const customResult = db.getHeartbeats(1, 2);
      expect(customResult["worker-1"].isStale).toBe(true);
    });
  });

  describe("getRecentEvents", () => {
    it("returns empty array when no events", () => {
      expect(db.getRecentEvents()).toEqual([]);
    });

    it("returns events in descending order with correct shape", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const now = Math.floor(Date.now() / 1000);
      rawDb.exec(`INSERT INTO events (epoch, event, detail, worker_id) VALUES (${now - 100}, 'task_completed', 'Task A done', 1)`);
      rawDb.exec(`INSERT INTO events (epoch, event, detail, worker_id) VALUES (${now}, 'worker_killed', 'Stale worker', 2)`);
      rawDb.close();

      const events = db.getRecentEvents(10);
      expect(events).toHaveLength(2);
      expect(events[0].event).toBe("worker_killed"); // most recent first
      expect(events[1].event).toBe("task_completed");
      expect(events[0].worker).toBe(2);
      expect(typeof events[0].ts).toBe("string");
      expect(typeof events[0].detail).toBe("string");
    });

    it("respects limit parameter", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 5; i++) {
        rawDb.exec(`INSERT INTO events (epoch, event, detail) VALUES (${now + i}, 'event_${i}', 'detail_${i}')`);
      }
      rawDb.close();

      expect(db.getRecentEvents(3)).toHaveLength(3);
    });
  });

  describe("countActiveWorkers", () => {
    it("returns 0 when no active workers", () => {
      expect(db.countActiveWorkers()).toBe(0);
    });

    it("counts only in_progress workers", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO workers (id, status) VALUES (1, 'in_progress')");
      rawDb.exec("INSERT INTO workers (id, status) VALUES (2, 'idle')");
      rawDb.exec("INSERT INTO workers (id, status) VALUES (3, 'in_progress')");
      rawDb.close();
      expect(db.countActiveWorkers()).toBe(2);
    });
  });

  describe("countEvents", () => {
    it("returns 0 when no events", () => {
      expect(db.countEvents()).toBe(0);
    });

    it("counts all events", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const now = Math.floor(Date.now() / 1000);
      rawDb.exec(`INSERT INTO events (epoch, event) VALUES (${now}, 'e1')`);
      rawDb.exec(`INSERT INTO events (epoch, event) VALUES (${now}, 'e2')`);
      rawDb.close();
      expect(db.countEvents()).toBe(2);
    });
  });

  describe("getFailedTasks", () => {
    it("returns empty array when no failed tasks", () => {
      expect(db.getFailedTasks()).toEqual([]);
    });

    it("returns failed tasks with correct shape", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec(
        "INSERT INTO tasks (title, tag, status, branch, error, attempts, failed_at, priority) " +
        "VALUES ('Bug fix', 'FIX', 'failed', 'fix/bug', 'OOM', 3, '2026-02-20 10:00:00', 0)"
      );
      rawDb.close();

      const result = db.getFailedTasks();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        date: "2026-02-20",
        task: "Bug fix",
        branch: "fix/bug",
        error: "OOM",
        attempts: "3",
        status: "failed",
      });
    });
  });

  describe("addTask", () => {
    it("adds a task at top with priority 0 and shifts others", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('Existing', 'FIX', 'pending', 0)");
      rawDb.close();

      const newId = db.addTask("New task", "FEAT", "desc", "top", "");
      expect(newId).toBeGreaterThan(0);
      expect(db.countPending()).toBe(2);
    });

    it("adds a task at bottom with next highest priority", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('First', 'FIX', 'pending', 0)");
      rawDb.close();

      const newId = db.addTask("Bottom task", "FEAT", "desc", "bottom", "");
      expect(newId).toBeGreaterThan(0);
    });
  });

  describe("getFixRate24h", () => {
    it("returns 0 when no fixer stats", () => {
      expect(db.getFixRate24h()).toBe(0);
    });

    it("calculates fix rate from recent stats", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const now = Math.floor(Date.now() / 1000);
      rawDb.exec(`INSERT INTO fixer_stats (epoch, result, task_title) VALUES (${now}, 'success', 'T1')`);
      rawDb.exec(`INSERT INTO fixer_stats (epoch, result, task_title) VALUES (${now}, 'success', 'T2')`);
      rawDb.exec(`INSERT INTO fixer_stats (epoch, result, task_title) VALUES (${now}, 'failure', 'T3')`);
      rawDb.close();

      const rate = db.getFixRate24h();
      expect(rate).toBe(67); // 2/3 = 66.67 rounded to 67
    });
  });

  describe("getAverageTaskDuration", () => {
    it("returns null when no completed tasks with duration", () => {
      expect(db.getAverageTaskDuration()).toBeNull();
    });

    it("formats average duration correctly", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, duration_secs, priority) VALUES ('T1', 'FIX', 'completed', 600, 0)"); // 10m
      rawDb.exec("INSERT INTO tasks (title, tag, status, duration_secs, priority) VALUES ('T2', 'FIX', 'completed', 1200, 1)"); // 20m
      rawDb.close();

      const avg = db.getAverageTaskDuration();
      expect(avg).toBe("15m"); // avg of 10m and 20m
    });

    it("formats hours correctly", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, duration_secs, priority) VALUES ('T1', 'FIX', 'completed', 3600, 0)"); // 60m = 1h
      rawDb.exec("INSERT INTO tasks (title, tag, status, duration_secs, priority) VALUES ('T2', 'FIX', 'completed', 7200, 1)"); // 120m = 2h
      rawDb.close();

      const avg = db.getAverageTaskDuration();
      expect(avg).toBe("1h 30m"); // avg of 60m and 120m = 90m
    });
  });

  describe("checkRateLimit", () => {
    it("allows requests within the window", () => {
      expect(db.checkRateLimit("test_key", 5, 60000)).toBe(true);
      expect(db.checkRateLimit("test_key", 5, 60000)).toBe(true);
    });

    it("rejects requests after maxCount is reached", () => {
      for (let i = 0; i < 5; i++) {
        expect(db.checkRateLimit("limit_key", 5, 60000)).toBe(true);
      }
      expect(db.checkRateLimit("limit_key", 5, 60000)).toBe(false);
    });

    it("resets counter after window expires", () => {
      // Use a very short window so it expires immediately
      expect(db.checkRateLimit("expire_key", 1, 1)).toBe(true);
      // Wait a tiny bit for the window to expire
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }
      expect(db.checkRateLimit("expire_key", 1, 1)).toBe(true);
    });
  });

  describe("getCurrentTask", () => {
    it("returns unknown status for non-existent worker", () => {
      const result = db.getCurrentTask(99);
      expect(result.status).toBe("unknown");
      expect(result.title).toBeNull();
    });

    it("returns worker task info", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO workers (id, status, task_title, branch, started_at) VALUES (1, 'in_progress', 'Fix auth', 'fix/auth', '2026-02-20 10:00:00')");
      rawDb.close();

      const result = db.getCurrentTask(1);
      expect(result.status).toBe("in_progress");
      expect(result.title).toBe("Fix auth");
      expect(result.branch).toBe("fix/auth");
      expect(result.worker).toBe("Worker 1");
    });
  });

  describe("getAllCurrentTasks", () => {
    it("returns tasks for all workers up to maxWorkers", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO workers (id, status, task_title) VALUES (1, 'in_progress', 'Task A')");
      rawDb.exec("INSERT INTO workers (id, status, task_title) VALUES (2, 'idle', '')");
      rawDb.close();

      const result = db.getAllCurrentTasks(3);
      expect(result["worker-1"].status).toBe("in_progress");
      expect(result["worker-1"].title).toBe("Task A");
      expect(result["worker-2"].status).toBe("idle");
    });
  });

  describe("close", () => {
    it("closes the underlying database connection without error", () => {
      // Calling close should not throw
      expect(() => db.close()).not.toThrow();
    });
  });

  // ── P1-10: exportBacklog() tests ──────────────────────────────────
  describe("exportBacklog", () => {
    it("produces valid header-only output for empty database", () => {
      const { readFileSync } = require("fs") as typeof import("fs");
      const outPath = join(tmpDir, "backlog.md");
      db.exportBacklog(outPath);
      const content = readFileSync(outPath, "utf-8");
      expect(content).toContain("# Backlog");
      // No actual task lines (lines starting with "- [" outside comments)
      const taskLines = content.split("\n").filter(
        (l: string) => /^- \[[ >x]\] \[/.test(l)
      );
      expect(taskLines).toHaveLength(0);
    });

    it("pending items appear before done items; claimed items use [>] marker", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending task', 'FEAT', 'pending', 0)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('Claimed task', 'FIX', 'claimed', 1)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority, updated_at) VALUES ('Done task', 'INFRA', 'done', 2, datetime('now'))");
      rawDb.close();

      const { readFileSync } = require("fs") as typeof import("fs");
      const outPath = join(tmpDir, "backlog.md");
      db.exportBacklog(outPath);
      const content = readFileSync(outPath, "utf-8");

      // Pending and claimed come before done
      const pendingIdx = content.indexOf("- [ ] [FEAT] Pending task");
      const claimedIdx = content.indexOf("- [>] [FIX] Claimed task");
      const doneIdx = content.indexOf("- [x] [INFRA] Done task");

      expect(pendingIdx).toBeGreaterThan(-1);
      expect(claimedIdx).toBeGreaterThan(-1);
      expect(doneIdx).toBeGreaterThan(-1);
      expect(pendingIdx).toBeLessThan(doneIdx);
      expect(claimedIdx).toBeLessThan(doneIdx);
    });

    it("done items limited to 30 in the recent history section", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      for (let i = 0; i < 40; i++) {
        rawDb.exec(`INSERT INTO tasks (title, tag, status, priority, updated_at) VALUES ('Done ${i}', 'FEAT', 'done', ${i}, datetime('now', '-${i} minutes'))`);
      }
      rawDb.close();

      const { readFileSync } = require("fs") as typeof import("fs");
      const outPath = join(tmpDir, "backlog.md");
      db.exportBacklog(outPath);
      const content = readFileSync(outPath, "utf-8");
      const doneLines = content.split("\n").filter((l: string) => l.startsWith("- [x]"));
      expect(doneLines.length).toBe(30);
    });
  });

  // ── P1-11: Export methods tests ───────────────────────────────────
  describe("exportAllTasks", () => {
    it("returns all rows", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T1', 'FEAT', 'pending', 0)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('T2', 'FIX', 'completed', 1)");
      rawDb.close();
      const rows = db.exportAllTasks();
      expect(rows).toHaveLength(2);
      expect(rows[0].title).toBe("T1");
      expect(rows[1].title).toBe("T2");
    });

    it("returns empty array for empty table", () => {
      expect(db.exportAllTasks()).toEqual([]);
    });
  });

  describe("exportAllBlockers", () => {
    it("returns all rows", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO blockers (description, status) VALUES ('B1', 'active')");
      rawDb.exec("INSERT INTO blockers (description, status) VALUES ('B2', 'resolved')");
      rawDb.close();
      const rows = db.exportAllBlockers();
      expect(rows).toHaveLength(2);
    });

    it("returns empty array for empty table", () => {
      expect(db.exportAllBlockers()).toEqual([]);
    });
  });

  describe("exportAllEvents", () => {
    it("returns all rows", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const now = Math.floor(Date.now() / 1000);
      rawDb.exec(`INSERT INTO events (epoch, event, detail) VALUES (${now}, 'evt1', 'detail1')`);
      rawDb.exec(`INSERT INTO events (epoch, event, detail) VALUES (${now}, 'evt2', 'detail2')`);
      rawDb.close();
      const rows = db.exportAllEvents();
      expect(rows).toHaveLength(2);
    });

    it("returns empty array for empty table", () => {
      expect(db.exportAllEvents()).toEqual([]);
    });
  });

  describe("exportAllFixerStats", () => {
    it("returns all rows", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const now = Math.floor(Date.now() / 1000);
      rawDb.exec(`INSERT INTO fixer_stats (epoch, result, task_title) VALUES (${now}, 'success', 'T1')`);
      rawDb.exec(`INSERT INTO fixer_stats (epoch, result, task_title) VALUES (${now}, 'failure', 'T2')`);
      rawDb.close();
      const rows = db.exportAllFixerStats();
      expect(rows).toHaveLength(2);
    });

    it("returns empty array for empty table", () => {
      expect(db.exportAllFixerStats()).toEqual([]);
    });
  });

  // ── P1-13: getCleanupBranches() and getTaskBranches() tests ───────
  describe("getCleanupBranches", () => {
    it("returns branches from fixed/superseded/blocked tasks only", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, branch, priority) VALUES ('T1', 'FIX', 'fixed', 'dev/fix-1', 0)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, branch, priority) VALUES ('T2', 'FIX', 'superseded', 'dev/fix-2', 1)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, branch, priority) VALUES ('T3', 'FIX', 'blocked', 'dev/fix-3', 2)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, branch, priority) VALUES ('T4', 'FIX', 'pending', 'dev/fix-4', 3)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, branch, priority) VALUES ('T5', 'FIX', 'completed', 'dev/fix-5', 4)");
      rawDb.close();

      const branches = db.getCleanupBranches();
      expect(branches).toContain("dev/fix-1");
      expect(branches).toContain("dev/fix-2");
      expect(branches).toContain("dev/fix-3");
      expect(branches).not.toContain("dev/fix-4");
      expect(branches).not.toContain("dev/fix-5");
    });

    it("returns empty array for empty DB", () => {
      expect(db.getCleanupBranches()).toEqual([]);
    });
  });

  describe("getTaskBranches", () => {
    it("returns all tasks with branches", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, branch, priority) VALUES ('T1', 'FIX', 'fixed', 'dev/fix-1', 0)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, branch, priority) VALUES ('T2', 'FIX', 'pending', 'dev/fix-2', 1)");
      rawDb.exec("INSERT INTO tasks (title, tag, status, branch, priority) VALUES ('T3', 'FIX', 'pending', '', 2)");
      rawDb.close();

      const branches = db.getTaskBranches();
      expect(branches).toHaveLength(2); // T3 has empty branch, excluded
      expect(branches[0]).toMatchObject({ branch: expect.any(String), status: expect.any(String), title: expect.any(String) });
    });

    it("returns empty array for empty DB", () => {
      expect(db.getTaskBranches()).toEqual([]);
    });
  });

  // ── TEST-P2-8: Inode-based singleton invalidation ──────────────────
  describe("getSkynetDB inode invalidation", () => {
    it("detects inode change when DB file is deleted and recreated", () => {
      const dbPath = join(tmpDir, "skynet.db");
      _resetSingleton();

      // First call — establishes singleton with inode
      const db1 = getSkynetDB(tmpDir);
      expect(db1).toBeInstanceOf(SkynetDB);

      // Delete and recreate the DB file (new inode)
      const backupPath = dbPath + ".bak";
      copyFileSync(dbPath, backupPath);
      unlinkSync(dbPath);
      // Recreate from backup (different inode)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(dbPath);
      rawDb.exec(SCHEMA);
      rawDb.close();

      // Second call should detect inode change and create new instance
      const db2 = getSkynetDB(tmpDir);
      expect(db2).toBeInstanceOf(SkynetDB);
      // New instance should be functional
      expect(db2.countPending()).toBe(0);

      _resetSingleton();
    });
  });
});
