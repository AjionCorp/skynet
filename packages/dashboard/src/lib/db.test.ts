import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SkynetDB } from "./db";

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

  describe("close", () => {
    it("closes the underlying database connection without error", () => {
      // Calling close should not throw
      expect(() => db.close()).not.toThrow();
    });
  });
});
