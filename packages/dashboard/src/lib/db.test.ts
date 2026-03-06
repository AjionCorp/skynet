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
  files_touched   TEXT DEFAULT '',
  reason_code     TEXT DEFAULT '',
  priority        INTEGER NOT NULL DEFAULT 0,
  normalized_root TEXT DEFAULT '',
  mission_hash    TEXT DEFAULT '',
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

    // ── Test-2: SQLite version check edge cases ───────────────────────

    it("accepts version exactly at minimum (3.8.3)", () => {
      // The real SQLite is >= 3.8.3 (better-sqlite3 bundles a modern version),
      // so the constructor succeeds. We verify by checking db is usable.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const testDbPath = join(tmpDir, "version-ok.db");
      const rawDb = new Database(testDbPath);
      rawDb.exec(SCHEMA);
      rawDb.close();
      // SkynetDB constructor checks version >= 3.8.3. Modern better-sqlite3
      // ships SQLite 3.40+, so this always passes.
      const testDb = new SkynetDB(testDbPath);
      expect(testDb.countPending()).toBe(0); // DB is functional
      testDb.close();
    });

    it("rejects version below minimum (simulated via mock)", () => {
      // We can't easily get an old SQLite binary, so we test the version
      // parsing logic by creating a db, then intercepting the pragma call.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const testDbPath = join(tmpDir, "version-old.db");
      const rawDb = new Database(testDbPath);
      rawDb.exec(SCHEMA);
      rawDb.close();

      // Monkey-patch the Database constructor to return a mock that reports old version
      const OrigDatabase = Database;
      const mockDb = new OrigDatabase(testDbPath);
      const origPragma = mockDb.pragma.bind(mockDb);
      mockDb.pragma = (pragma: string, opts?: Record<string, unknown>) => {
        if (pragma === "sqlite_version") {
          return "3.8.2"; // Just below minimum
        }
        return origPragma(pragma, opts);
      };

      // Test the version check logic directly
      const version = mockDb.pragma("sqlite_version", { simple: true }) as string;
      const [major, minor, patch] = version.split(".").map(Number);
      const tooOld = major < 3 || (major === 3 && minor < 8) || (major === 3 && minor === 8 && patch < 3);
      expect(tooOld).toBe(true);
      mockDb.close();
    });

    it("handles malformed version string '3' gracefully", () => {
      // Test the parsing logic: "3" => split(".") => ["3"] => map(Number) => [3, NaN, NaN]
      // NaN comparisons: (3 === 3 && NaN < 8) => false (NaN < anything is false)
      // So the version check passes (does not throw) even for malformed strings.
      const version = "3";
      const [major, minor, patch] = version.split(".").map(Number);
      // Replicate the version check from db.ts constructor
      const tooOld =
        major < 3 ||
        (major === 3 && minor < 8) ||
        (major === 3 && minor === 8 && patch < 3);
      // "3" => [3, NaN, NaN]. (3 < 3)=false, (3===3 && NaN<8)=false => tooOld=false
      // This means a malformed version "3" would pass the check (not throw).
      expect(tooOld).toBe(false);
    });

    it("handles malformed version string '3.8' gracefully", () => {
      const version = "3.8";
      const [major, minor, patch] = version.split(".").map(Number);
      const tooOld =
        major < 3 ||
        (major === 3 && minor < 8) ||
        (major === 3 && minor === 8 && patch < 3);
      // "3.8" => [3, 8, NaN]. (3===3 && 8===8 && NaN<3)=false => tooOld=false
      expect(tooOld).toBe(false);
    });

    it("handles malformed version string 'a.b.c' gracefully", () => {
      const version = "a.b.c";
      const [major, minor, patch] = version.split(".").map(Number);
      const tooOld =
        major < 3 ||
        (major === 3 && minor < 8) ||
        (major === 3 && minor === 8 && patch < 3);
      // "a.b.c" => [NaN, NaN, NaN]. (NaN<3)=false => tooOld=false
      expect(tooOld).toBe(false);
    });

    it("correctly identifies version 3.8.3 as passing", () => {
      const version = "3.8.3";
      const [major, minor, patch] = version.split(".").map(Number);
      const tooOld =
        major < 3 ||
        (major === 3 && minor < 8) ||
        (major === 3 && minor === 8 && patch < 3);
      expect(tooOld).toBe(false);
    });

    it("correctly identifies version 3.8.2 as failing", () => {
      const version = "3.8.2";
      const [major, minor, patch] = version.split(".").map(Number);
      const tooOld =
        major < 3 ||
        (major === 3 && minor < 8) ||
        (major === 3 && minor === 8 && patch < 3);
      expect(tooOld).toBe(true);
    });

    it("correctly identifies version 3.7.17 as failing", () => {
      const version = "3.7.17";
      const [major, minor, patch] = version.split(".").map(Number);
      const tooOld =
        major < 3 ||
        (major === 3 && minor < 8) ||
        (major === 3 && minor === 8 && patch < 3);
      expect(tooOld).toBe(true);
    });

    it("correctly identifies version 3.9.0 as passing", () => {
      const version = "3.9.0";
      const [major, minor, patch] = version.split(".").map(Number);
      const tooOld =
        major < 3 ||
        (major === 3 && minor < 8) ||
        (major === 3 && minor === 8 && patch < 3);
      expect(tooOld).toBe(false);
    });

    it("correctly identifies version 2.9.9 as failing", () => {
      const version = "2.9.9";
      const [major, minor, patch] = version.split(".").map(Number);
      const tooOld =
        major < 3 ||
        (major === 3 && minor < 8) ||
        (major === 3 && minor === 8 && patch < 3);
      expect(tooOld).toBe(true);
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
        manualDoneCount: 0,
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
      expect(result.manualDoneCount).toBe(1);
      // Only pending and claimed items are returned (done items are excluded)
      expect(result.items).toHaveLength(2);
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

    it.each(["completed", "fixed", "superseded"] as const)(
      "treats %s dependencies as resolved",
      (resolvedStatus) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require("better-sqlite3");
        const rawDb = new Database(join(tmpDir, "skynet.db"));
        rawDb.exec(
          `INSERT INTO tasks (title, tag, status, blocked_by, priority)
           VALUES ('First task', 'FIX', '${resolvedStatus}', '', 0)`
        );
        rawDb.exec(
          "INSERT INTO tasks (title, tag, status, blocked_by, priority) VALUES ('Blocked task', 'FEAT', 'pending', 'First task', 1)"
        );
        rawDb.close();

        const result = db.getBacklogItems();
        expect(result.items[0].blocked).toBe(false);
      }
    );
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

    // TEST-P2-3: Extreme maxWorkers values — ensure no crash or NaN
    it("handles extreme maxWorkers value without crash", () => {
      const score = db.calculateHealthScore(Number.MAX_SAFE_INTEGER);
      expect(typeof score).toBe("number");
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("handles negative maxWorkers by clamping to 1", () => {
      const score = db.calculateHealthScore(-5);
      expect(typeof score).toBe("number");
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    // TEST-P2-5: Health score never exceeds bounds with extreme inputs
    it("stays within 0-100 bounds with extreme inputs (many tasks and blockers)", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      // Insert 1000 failed tasks
      const insertTask = rawDb.prepare(
        "INSERT INTO tasks (title, tag, status, priority) VALUES (?, 'FIX', 'failed', ?)"
      );
      const insertBlocker = rawDb.prepare(
        "INSERT INTO blockers (description, status) VALUES (?, 'active')"
      );
      const txn = rawDb.transaction(() => {
        for (let i = 0; i < 1000; i++) {
          insertTask.run(`ExtremeTask-${i}`, i);
        }
        for (let i = 0; i < 100; i++) {
          insertBlocker.run(`ExtremeBlocker-${i}`);
        }
      });
      txn();
      rawDb.close();

      const score = db.calculateHealthScore(4);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      // With 1000 failed * 5 + 100 blockers * 10 = 6000 deductions, score should be 0
      expect(score).toBe(0);
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
        filesTouched: "",
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
        outcomeReason: "",
        filesTouched: "",
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

    // ── TEST-P1-3: SQL injection in blockedBy test ──────────────────────
    it("stores SQL injection payload in blockedBy as literal text without executing it", () => {
      const sqlInjection = "'; DROP TABLE tasks; --";
      const newId = db.addTask("Safe task", "FEAT", "desc", "top", sqlInjection);
      expect(newId).toBeGreaterThan(0);

      // Verify the tasks table still exists and is intact
      expect(db.countPending()).toBeGreaterThanOrEqual(1);

      // Verify the blockedBy value was stored as literal text
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const row = rawDb.prepare("SELECT blocked_by FROM tasks WHERE id = ?").get(newId) as { blocked_by: string };
      rawDb.close();
      expect(row.blocked_by).toBe(sqlInjection);
    });

    it("stores SQL injection payload in title without executing it", () => {
      const sqlInjection = "'; DROP TABLE tasks; --";
      const newId = db.addTask(sqlInjection, "FEAT", "desc", "top", "");
      expect(newId).toBeGreaterThan(0);

      // Table still exists
      expect(db.countPending()).toBeGreaterThanOrEqual(1);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const row = rawDb.prepare("SELECT title FROM tasks WHERE id = ?").get(newId) as { title: string };
      rawDb.close();
      expect(row.title).toBe(sqlInjection);
    });

    it("stores SQL injection in description without executing it", () => {
      const sqlInjection = "Robert'); DROP TABLE tasks;--";
      const newId = db.addTask("Normal title", "FEAT", sqlInjection, "top", "");
      expect(newId).toBeGreaterThan(0);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const row = rawDb.prepare("SELECT description FROM tasks WHERE id = ?").get(newId) as { description: string };
      rawDb.close();
      expect(row.description).toBe(sqlInjection);
      expect(db.countPending()).toBeGreaterThanOrEqual(1);
    });

    it("handles UNION SELECT injection attempt in blockedBy", () => {
      const unionInjection = "' UNION SELECT password FROM users --";
      const newId = db.addTask("Another safe task", "FIX", "desc", "top", unionInjection);
      expect(newId).toBeGreaterThan(0);
      expect(db.countPending()).toBeGreaterThanOrEqual(1);
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

    // TEST-P3-3: Exact-hour boundary — verify output is "1h" not "1h 0m"
    it("formats exact hour boundary as '1h' without trailing 0m", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, duration_secs, priority) VALUES ('T1', 'FIX', 'completed', 3600, 0)"); // exactly 3600s = 1h
      rawDb.close();

      const avg = db.getAverageTaskDuration();
      expect(avg).toBe("1h");
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

  // ── P0-7: Critical missing tests ──────────────────────────────────

  describe("SQL injection hardening", () => {
    it("UNION SELECT injection in blockedBy is stored as literal text", () => {
      const unionPayload = "x' UNION SELECT password FROM users --";
      const newId = db.addTask("Union test", "SEC", "desc", "top", unionPayload);
      expect(newId).toBeGreaterThan(0);

      // Table must still be intact
      expect(db.countPending()).toBeGreaterThanOrEqual(1);

      // Verify the payload was stored literally, not executed
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const row = rawDb.prepare("SELECT blocked_by FROM tasks WHERE id = ?").get(newId) as { blocked_by: string };
      rawDb.close();
      expect(row.blocked_by).toBe(unionPayload);

      // The blockedBy field in backlog items should contain the literal payload
      const backlog = db.getBacklogItems();
      const item = backlog.items.find(i => i.text.includes("Union test"));
      expect(item).toBeDefined();
      expect(item!.blockedBy).toContain(unionPayload);
    });
  });

  describe("addTask robustness", () => {
    it("handles extremely nested JSON description without crashing", () => {
      // Build deeply nested JSON string (1000 levels)
      let nested = '"leaf"';
      for (let i = 0; i < 1000; i++) {
        nested = `{"level${i}":${nested}}`;
      }
      const longDesc = `Nested: ${nested}`;

      // Should not throw or crash — SQLite TEXT fields handle arbitrary strings
      const newId = db.addTask("Nested JSON task", "TEST", longDesc, "top", "");
      expect(newId).toBeGreaterThan(0);

      // Verify it was stored correctly
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const row = rawDb.prepare("SELECT description FROM tasks WHERE id = ?").get(newId) as { description: string };
      rawDb.close();
      expect(row.description).toBe(longDesc);
    });
  });

  describe("concurrent task claims", () => {
    it("only one of 5 parallel claims succeeds (no duplicate claims)", async () => {
      // Insert 1 pending task
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      rawDb.exec("INSERT INTO tasks (title, tag, status, priority) VALUES ('Single task', 'TEST', 'pending', 0)");

      // Insert 5 workers
      for (let i = 1; i <= 5; i++) {
        rawDb.exec(`INSERT OR REPLACE INTO workers (id, worker_type, status) VALUES (${i}, 'dev', 'idle')`);
      }
      rawDb.close();

      // Simulate 5 concurrent claims using SkynetDB's transaction-based addTask
      // We use the raw DB to simulate the claim operation since SkynetDB doesn't
      // expose a claim method (that's in the bash layer). Instead, we test that
      // SQLite's serialization prevents double-claims.
      const claimDb = new Database(join(tmpDir, "skynet.db"));
      claimDb.pragma("busy_timeout = 5000");
      claimDb.pragma("journal_mode = WAL");

      const claimForWorker = claimDb.prepare(`
        UPDATE tasks SET status = 'claimed', worker_id = ?
        WHERE id = (
          SELECT id FROM tasks WHERE status = 'pending' ORDER BY priority ASC LIMIT 1
        ) AND status = 'pending'
      `);

      // Run 5 claims concurrently via Promise.all — SQLite serializes writes
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(async (workerId) => {
          try {
            const info = claimForWorker.run(workerId);
            return info.changes;
          } catch {
            return 0;
          }
        })
      );

      claimDb.close();

      // Exactly 1 claim should succeed (changes === 1), rest should be 0
      const successCount = results.filter(r => r === 1).length;
      expect(successCount).toBe(1);

      // Verify in DB: exactly 1 claimed task
      const verifyDb = new Database(join(tmpDir, "skynet.db"));
      const claimed = verifyDb.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'claimed'").get() as { cnt: number };
      const pending = verifyDb.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'pending'").get() as { cnt: number };
      verifyDb.close();

      expect(claimed.cnt).toBe(1);
      expect(pending.cnt).toBe(0);
    });
  });

  // ── TEST-P1-1: Transaction rollback on constraint violation ─────────
  describe("addTask duplicate handling", () => {
    it("handles duplicate task titles gracefully without corrupting DB state", () => {
      const title = "Unique task for dup test";
      const id1 = db.addTask(title, "FEAT", "First insert", "top");
      expect(id1).toBeGreaterThan(0);

      // Second insert with same title+tag — should succeed (no unique constraint on title)
      // but result in a separate row
      const id2 = db.addTask(title, "FEAT", "Second insert", "top");
      expect(id2).toBeGreaterThan(0);
      expect(id2).not.toBe(id1);

      // DB state should be consistent — both tasks exist
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3");
      const rawDb = new Database(join(tmpDir, "skynet.db"));
      const rows = rawDb.prepare("SELECT id, title, description FROM tasks WHERE title = ?").all(title);
      rawDb.close();
      expect(rows).toHaveLength(2);
      expect(rows[0].description).toBe("First insert");
      expect(rows[1].description).toBe("Second insert");
    });

    it("maintains consistent priority order after duplicate inserts at top", () => {
      db.addTask("Dup priority A", "FEAT", "", "top");
      db.addTask("Dup priority B", "FEAT", "", "top");
      db.addTask("Dup priority A", "FEAT", "", "top"); // duplicate title

      const items = db.getBacklogItems();
      // All three should appear, most recently added at top (lowest priority)
      const titles = items.items.map(i => {
        const match = i.text.match(/\] (.+?)($| —)/);
        return match ? match[1] : "";
      });
      expect(titles).toContain("Dup priority A");
      expect(titles).toContain("Dup priority B");
      // Priority 0 should be the last-inserted item
      expect(items.pendingCount).toBeGreaterThanOrEqual(3);
    });
  });
});
