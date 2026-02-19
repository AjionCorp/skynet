import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, spawnSync } from "child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  unlinkSync,
  statSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// Shell-script lock acquisition & task-claiming tests
// Tests the actual bash patterns used by dev-worker.sh: PID lock files,
// mkdir-based mutexes, stale-lock detection, and concurrent task claiming.
// ---------------------------------------------------------------------------

/** Create a unique temp dir for each test */
function makeTmpDir(): string {
  const id = randomBytes(6).toString("hex");
  const dir = join(tmpdir(), `skynet-lock-test-${id}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove temp dir and all contents */
function cleanTmpDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a minimal shell harness that defines the same lock/claim functions
 * as dev-worker.sh, but with configurable paths and without the main loop.
 */
function shellHarness(vars: {
  lockPrefix: string;
  backlog: string;
}): string {
  return `
set -euo pipefail

BACKLOG_LOCK="${vars.lockPrefix}-backlog.lock"
BACKLOG="${vars.backlog}"

# Portable file_mtime (same as _compat.sh)
file_mtime() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f %m "$1" 2>/dev/null || echo 0
  else
    stat -c %Y "$1" 2>/dev/null || echo 0
  fi
}

# --- Mutex helpers (same as dev-worker.sh) ---
acquire_lock() {
  local attempts=0
  while ! mkdir "$BACKLOG_LOCK" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 50 ]; then
      if [ -d "$BACKLOG_LOCK" ]; then
        local lock_mtime
        lock_mtime=$(file_mtime "$BACKLOG_LOCK")
        local lock_age=$(( $(date +%s) - lock_mtime ))
        if [ "$lock_age" -gt 30 ]; then
          rm -rf "$BACKLOG_LOCK" 2>/dev/null || true
          mkdir "$BACKLOG_LOCK" 2>/dev/null && return 0
        fi
      fi
      return 1
    fi
    sleep 0.1
  done
  return 0
}

release_lock() {
  rmdir "$BACKLOG_LOCK" 2>/dev/null || rm -rf "$BACKLOG_LOCK" 2>/dev/null || true
}

# --- Task helpers (same as dev-worker.sh) ---
claim_next_task() {
  if ! acquire_lock; then echo ""; return; fi
  local task
  task=$(grep -m1 '^\\- \\[ \\]' "$BACKLOG" 2>/dev/null || true)
  if [ -n "$task" ]; then
    if ! awk -v target="$task" 'found == 0 && $0 == target {sub(/- \\[ \\]/, "- [>]"); found=1} {print}' \\
      "$BACKLOG" > "$BACKLOG.tmp" || ! mv "$BACKLOG.tmp" "$BACKLOG"; then
      release_lock
      echo ""
      return
    fi
    release_lock
    echo "$task"
  else
    release_lock
  fi
}

unclaim_task() {
  local task_title="$1"
  acquire_lock || return
  if [ -f "$BACKLOG" ]; then
    awk -v title="$task_title" '{
      if ($0 == "- [>] " title) print "- [ ] " title
      else print
    }' "$BACKLOG" > "$BACKLOG.tmp"
    mv "$BACKLOG.tmp" "$BACKLOG"
  fi
  release_lock
}

mark_in_backlog() {
  local old_line="$1"
  local new_line="$2"
  local title="\${old_line#- \\[>\\] }"
  acquire_lock || return
  if [ -f "$BACKLOG" ]; then
    awk -v title="$title" -v new="$new_line" '{
      if ($0 == "- [>] " title || $0 == "- [ ] " title) print new
      else print
    }' "$BACKLOG" > "$BACKLOG.tmp"
    mv "$BACKLOG.tmp" "$BACKLOG"
  fi
  release_lock
}

remove_from_backlog() {
  local line_to_remove="$1"
  acquire_lock || return
  if [ -f "$BACKLOG" ]; then
    grep -Fxv -- "$line_to_remove" "$BACKLOG" > "$BACKLOG.tmp" || true
    mv "$BACKLOG.tmp" "$BACKLOG"
  fi
  release_lock
}
`.trim();
}

// ===========================================================================
// Test suites
// ===========================================================================

describe("Shell script lock acquisition", () => {
  let tmpDir: string;
  let lockPrefix: string;
  let backlogPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    lockPrefix = join(tmpDir, "skynet-test");
    backlogPath = join(tmpDir, "backlog.md");
  });

  afterEach(() => {
    cleanTmpDir(tmpDir);
  });

  // -----------------------------------------------------------------------
  // PID lock
  // -----------------------------------------------------------------------
  describe("PID lock", () => {
    it("creates lock file with current PID", () => {
      const lockfile = join(tmpDir, "test.lock");
      const result = spawnSync("bash", [
        "-c",
        `LOCKFILE="${lockfile}"
         echo $$ > "$LOCKFILE"
         cat "$LOCKFILE"`,
      ]);
      const pid = result.stdout.toString().trim();
      expect(Number(pid)).toBeGreaterThan(0);
      expect(existsSync(lockfile)).toBe(true);
    });

    it("prevents duplicate run when PID is alive", () => {
      const lockfile = join(tmpDir, "test.lock");
      // Write our own PID (which is alive) to the lock file
      writeFileSync(lockfile, String(process.pid));

      const result = spawnSync("bash", [
        "-c",
        `LOCKFILE="${lockfile}"
         if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
           echo "ALREADY_RUNNING"
           exit 0
         fi
         echo "WOULD_RUN"`,
      ]);
      expect(result.stdout.toString().trim()).toBe("ALREADY_RUNNING");
    });

    it("allows run when lock file PID is dead (stale)", () => {
      const lockfile = join(tmpDir, "test.lock");
      // Write a PID that definitely doesn't exist (99999999)
      writeFileSync(lockfile, "99999999");

      const result = spawnSync("bash", [
        "-c",
        `LOCKFILE="${lockfile}"
         if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
           echo "ALREADY_RUNNING"
           exit 0
         fi
         echo $$ > "$LOCKFILE"
         echo "WOULD_RUN"`,
      ]);
      expect(result.stdout.toString().trim()).toBe("WOULD_RUN");
      // Lock file should now contain a real PID
      const newPid = readFileSync(lockfile, "utf8").trim();
      expect(Number(newPid)).toBeGreaterThan(0);
      expect(newPid).not.toBe("99999999");
    });

    it("cleans up lock file on EXIT trap", () => {
      const lockfile = join(tmpDir, "test.lock");

      spawnSync("bash", [
        "-c",
        `LOCKFILE="${lockfile}"
         echo $$ > "$LOCKFILE"
         trap "rm -f $LOCKFILE" EXIT
         # Script exits naturally — trap fires`,
      ]);
      expect(existsSync(lockfile)).toBe(false);
    });

    it("cleans up lock file even on error (ERR + EXIT traps)", () => {
      const lockfile = join(tmpDir, "test.lock");

      spawnSync("bash", [
        "-c",
        `set -e
         LOCKFILE="${lockfile}"
         echo $$ > "$LOCKFILE"
         trap "rm -f $LOCKFILE" EXIT
         # Trigger an error — EXIT trap should still fire
         false`,
      ]);
      expect(existsSync(lockfile)).toBe(false);
    });

    it("is_running() returns true for alive PID", () => {
      const lockfile = join(tmpDir, "test.lock");
      writeFileSync(lockfile, String(process.pid));

      const result = spawnSync("bash", [
        "-c",
        `is_running() {
           local lockfile="$1"
           [ -f "$lockfile" ] && kill -0 "$(cat "$lockfile")" 2>/dev/null
         }
         if is_running "${lockfile}"; then echo "RUNNING"; else echo "NOT_RUNNING"; fi`,
      ]);
      expect(result.stdout.toString().trim()).toBe("RUNNING");
    });

    it("is_running() returns false for dead PID", () => {
      const lockfile = join(tmpDir, "test.lock");
      writeFileSync(lockfile, "99999999");

      const result = spawnSync("bash", [
        "-c",
        `is_running() {
           local lockfile="$1"
           [ -f "$lockfile" ] && kill -0 "$(cat "$lockfile")" 2>/dev/null
         }
         if is_running "${lockfile}"; then echo "RUNNING"; else echo "NOT_RUNNING"; fi`,
      ]);
      expect(result.stdout.toString().trim()).toBe("NOT_RUNNING");
    });

    it("is_running() returns false for missing lock file", () => {
      const result = spawnSync("bash", [
        "-c",
        `is_running() {
           local lockfile="$1"
           [ -f "$lockfile" ] && kill -0 "$(cat "$lockfile")" 2>/dev/null
         }
         if is_running "${tmpDir}/nonexistent.lock"; then echo "RUNNING"; else echo "NOT_RUNNING"; fi`,
      ]);
      expect(result.stdout.toString().trim()).toBe("NOT_RUNNING");
    });
  });

  // -----------------------------------------------------------------------
  // mkdir mutex
  // -----------------------------------------------------------------------
  describe("mkdir mutex (acquire_lock / release_lock)", () => {
    it("creates directory on acquire", () => {
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });
      spawnSync("bash", ["-c", `${harness}\nacquire_lock`]);
      expect(existsSync(`${lockPrefix}-backlog.lock`)).toBe(true);
      expect(statSync(`${lockPrefix}-backlog.lock`).isDirectory()).toBe(true);
    });

    it("release_lock removes the directory", () => {
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });
      spawnSync("bash", [
        "-c",
        `${harness}\nacquire_lock\nrelease_lock`,
      ]);
      expect(existsSync(`${lockPrefix}-backlog.lock`)).toBe(false);
    });

    it("acquire_lock blocks until released then succeeds", () => {
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });
      const flagFile = join(tmpDir, "acquired.flag");

      // Pre-create lock dir, then remove it after 0.5s in background
      mkdirSync(`${lockPrefix}-backlog.lock`);

      const result = spawnSync("bash", [
        "-c",
        `${harness}
         # Remove the pre-existing lock in background after 0.3s
         (sleep 0.3 && rmdir "${lockPrefix}-backlog.lock") &
         acquire_lock && echo "ACQUIRED" > "${flagFile}"
         release_lock`,
      ], { timeout: 10000 });

      expect(existsSync(flagFile)).toBe(true);
      expect(readFileSync(flagFile, "utf8").trim()).toBe("ACQUIRED");
    });

    it("acquire_lock fails after max attempts when lock is held by live process", () => {
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      // Create a fresh lock dir (will appear non-stale)
      mkdirSync(`${lockPrefix}-backlog.lock`);

      // Override sleep to be faster (0.01 instead of 0.1) for test speed
      const fastHarness = harness.replace("sleep 0.1", "sleep 0.01");
      const result = spawnSync("bash", [
        "-c",
        `${fastHarness}
         if acquire_lock; then echo "ACQUIRED"; else echo "FAILED"; fi`,
      ], { timeout: 10000 });

      expect(result.stdout.toString().trim()).toBe("FAILED");
    });

    it("detects and breaks stale lock older than 30 seconds", () => {
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });
      const lockDir = `${lockPrefix}-backlog.lock`;

      // Create the lock dir
      mkdirSync(lockDir);

      // Use touch to make it look old (60 seconds ago)
      spawnSync("touch", ["-t", getOldTimestamp(60), lockDir]);

      // Override sleep to be faster for test speed
      const fastHarness = harness.replace("sleep 0.1", "sleep 0.01");
      const result = spawnSync("bash", [
        "-c",
        `${fastHarness}
         if acquire_lock; then echo "ACQUIRED"; else echo "FAILED"; fi
         release_lock`,
      ], { timeout: 10000 });

      expect(result.stdout.toString().trim()).toBe("ACQUIRED");
    });

    it("does not break fresh lock (< 30s old)", () => {
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      // Create a fresh lock dir — just created, age ≈ 0
      mkdirSync(`${lockPrefix}-backlog.lock`);

      const fastHarness = harness.replace("sleep 0.1", "sleep 0.01");
      const result = spawnSync("bash", [
        "-c",
        `${fastHarness}
         if acquire_lock; then echo "ACQUIRED"; else echo "FAILED"; fi`,
      ], { timeout: 10000 });

      expect(result.stdout.toString().trim()).toBe("FAILED");
    });

    it("release_lock is idempotent (no error on double release)", () => {
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });
      const result = spawnSync("bash", [
        "-c",
        `${harness}
         acquire_lock
         release_lock
         release_lock
         echo "OK"`,
      ]);
      expect(result.stdout.toString().trim()).toBe("OK");
      expect(result.status).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Stale in-progress task detection
  // -----------------------------------------------------------------------
  describe("Stale in-progress task detection", () => {
    it("detects fresh in_progress task (should skip)", () => {
      const taskFile = join(tmpDir, "current-task-1.md");
      writeFileSync(taskFile, "## My task\n**Status:** in_progress\n");

      const result = spawnSync("bash", [
        "-c",
        `set -euo pipefail
         WORKER_TASK_FILE="${taskFile}"
         STALE_MINUTES=45

         file_mtime() {
           if [[ "$(uname -s)" == "Darwin" ]]; then
             stat -f %m "$1" 2>/dev/null || echo 0
           else
             stat -c %Y "$1" 2>/dev/null || echo 0
           fi
         }

         if grep -q "in_progress" "$WORKER_TASK_FILE" 2>/dev/null; then
           last_modified=$(file_mtime "$WORKER_TASK_FILE")
           now=$(date +%s)
           age_minutes=$(( (now - last_modified) / 60 ))
           if [ "$age_minutes" -lt "$STALE_MINUTES" ]; then
             echo "SKIP_FRESH"
           else
             echo "STALE"
           fi
         else
           echo "NO_TASK"
         fi`,
      ]);
      expect(result.stdout.toString().trim()).toBe("SKIP_FRESH");
    });

    it("detects stale in_progress task (age > STALE_MINUTES)", () => {
      const taskFile = join(tmpDir, "current-task-1.md");
      writeFileSync(taskFile, "## Stale task\n**Status:** in_progress\n");

      // Touch it to be 60 minutes old
      spawnSync("touch", ["-t", getOldTimestamp(3600), taskFile]);

      const result = spawnSync("bash", [
        "-c",
        `set -euo pipefail
         WORKER_TASK_FILE="${taskFile}"
         STALE_MINUTES=45

         file_mtime() {
           if [[ "$(uname -s)" == "Darwin" ]]; then
             stat -f %m "$1" 2>/dev/null || echo 0
           else
             stat -c %Y "$1" 2>/dev/null || echo 0
           fi
         }

         if grep -q "in_progress" "$WORKER_TASK_FILE" 2>/dev/null; then
           last_modified=$(file_mtime "$WORKER_TASK_FILE")
           now=$(date +%s)
           age_minutes=$(( (now - last_modified) / 60 ))
           if [ "$age_minutes" -lt "$STALE_MINUTES" ]; then
             echo "SKIP_FRESH"
           else
             echo "STALE"
           fi
         else
           echo "NO_TASK"
         fi`,
      ]);
      expect(result.stdout.toString().trim()).toBe("STALE");
    });

    it("handles missing task file gracefully", () => {
      const result = spawnSync("bash", [
        "-c",
        `set -euo pipefail
         WORKER_TASK_FILE="${tmpDir}/nonexistent.md"

         if grep -q "in_progress" "$WORKER_TASK_FILE" 2>/dev/null; then
           echo "HAS_TASK"
         else
           echo "NO_TASK"
         fi`,
      ]);
      expect(result.stdout.toString().trim()).toBe("NO_TASK");
    });

    it("handles task file without in_progress status", () => {
      const taskFile = join(tmpDir, "current-task-1.md");
      writeFileSync(taskFile, "## Completed task\n**Status:** completed\n");

      const result = spawnSync("bash", [
        "-c",
        `set -euo pipefail
         WORKER_TASK_FILE="${taskFile}"

         if grep -q "in_progress" "$WORKER_TASK_FILE" 2>/dev/null; then
           echo "HAS_TASK"
         else
           echo "NO_TASK"
         fi`,
      ]);
      expect(result.stdout.toString().trim()).toBe("NO_TASK");
    });

    it("file_mtime returns 0 for nonexistent file", () => {
      const result = spawnSync("bash", [
        "-c",
        `file_mtime() {
           if [[ "$(uname -s)" == "Darwin" ]]; then
             stat -f %m "$1" 2>/dev/null || echo 0
           else
             stat -c %Y "$1" 2>/dev/null || echo 0
           fi
         }
         file_mtime "${tmpDir}/nonexistent"`,
      ]);
      expect(result.stdout.toString().trim()).toBe("0");
    });
  });

  // -----------------------------------------------------------------------
  // Task claiming
  // -----------------------------------------------------------------------
  describe("Task claiming (claim_next_task)", () => {
    const SAMPLE_BACKLOG =
      "# Backlog\n\n- [ ] [FEAT] Add login page\n- [ ] [FIX] Fix auth bug\n- [ ] [FEAT] Add dashboard\n- [x] [FEAT] Setup project";

    it("claims the first unchecked task", () => {
      writeFileSync(backlogPath, SAMPLE_BACKLOG);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      const result = spawnSync("bash", [
        "-c",
        `${harness}\nclaim_next_task`,
      ]);
      expect(result.stdout.toString().trim()).toBe(
        "- [ ] [FEAT] Add login page"
      );
    });

    it("changes marker from [ ] to [>] in backlog file", () => {
      writeFileSync(backlogPath, SAMPLE_BACKLOG);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", ["-c", `${harness}\nclaim_next_task`]);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [>] [FEAT] Add login page");
      expect(content).not.toMatch(/^- \[ \] \[FEAT\] Add login page$/m);
    });

    it("only claims one task at a time", () => {
      writeFileSync(backlogPath, SAMPLE_BACKLOG);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", ["-c", `${harness}\nclaim_next_task`]);

      const content = readFileSync(backlogPath, "utf8");
      // Only first task should be claimed
      expect(content).toContain("- [>] [FEAT] Add login page");
      expect(content).toContain("- [ ] [FIX] Fix auth bug");
      expect(content).toContain("- [ ] [FEAT] Add dashboard");
    });

    it("second claim gets the second task", () => {
      writeFileSync(backlogPath, SAMPLE_BACKLOG);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      // Claim twice
      spawnSync("bash", ["-c", `${harness}\nclaim_next_task > /dev/null`]);
      const result = spawnSync("bash", [
        "-c",
        `${harness}\nclaim_next_task`,
      ]);

      expect(result.stdout.toString().trim()).toBe(
        "- [ ] [FIX] Fix auth bug"
      );

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [>] [FEAT] Add login page");
      expect(content).toContain("- [>] [FIX] Fix auth bug");
      expect(content).toContain("- [ ] [FEAT] Add dashboard");
    });

    it("returns empty string when backlog is empty", () => {
      writeFileSync(backlogPath, "# Backlog\n\n- [x] [FEAT] Done task");
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      const result = spawnSync("bash", [
        "-c",
        `${harness}\nresult=$(claim_next_task)\nif [ -z "$result" ]; then echo "EMPTY"; else echo "$result"; fi`,
      ]);
      expect(result.stdout.toString().trim()).toBe("EMPTY");
    });

    it("returns empty string when backlog file is missing", () => {
      // Don't create backlog file
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      const result = spawnSync("bash", [
        "-c",
        `${harness}\nresult=$(claim_next_task)\nif [ -z "$result" ]; then echo "EMPTY"; else echo "$result"; fi`,
      ]);
      expect(result.stdout.toString().trim()).toBe("EMPTY");
    });

    it("releases lock even when backlog is empty", () => {
      writeFileSync(backlogPath, "# Backlog\n");
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", ["-c", `${harness}\nclaim_next_task`]);
      expect(existsSync(`${lockPrefix}-backlog.lock`)).toBe(false);
    });

    it("preserves completed items when claiming", () => {
      writeFileSync(backlogPath, SAMPLE_BACKLOG);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", ["-c", `${harness}\nclaim_next_task`]);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [x] [FEAT] Setup project");
    });
  });

  // -----------------------------------------------------------------------
  // unclaim_task
  // -----------------------------------------------------------------------
  describe("unclaim_task", () => {
    it("reverts [>] back to [ ]", () => {
      const backlog =
        "# Backlog\n\n- [>] [FEAT] Add login page\n- [ ] [FIX] Fix auth bug";
      writeFileSync(backlogPath, backlog);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", [
        "-c",
        `${harness}\nunclaim_task "[FEAT] Add login page"`,
      ]);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [ ] [FEAT] Add login page");
      expect(content).not.toContain("- [>] [FEAT] Add login page");
    });

    it("does not affect other tasks", () => {
      const backlog =
        "# Backlog\n\n- [>] [FEAT] Add login page\n- [>] [FIX] Fix auth bug";
      writeFileSync(backlogPath, backlog);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", [
        "-c",
        `${harness}\nunclaim_task "[FEAT] Add login page"`,
      ]);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [ ] [FEAT] Add login page");
      expect(content).toContain("- [>] [FIX] Fix auth bug");
    });

    it("is a no-op if task is not claimed", () => {
      const backlog = "# Backlog\n\n- [ ] [FEAT] Add login page";
      writeFileSync(backlogPath, backlog);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", [
        "-c",
        `${harness}\nunclaim_task "[FEAT] Add login page"`,
      ]);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [ ] [FEAT] Add login page");
    });
  });

  // -----------------------------------------------------------------------
  // mark_in_backlog
  // -----------------------------------------------------------------------
  describe("mark_in_backlog", () => {
    it("marks claimed task as completed", () => {
      const backlog =
        "# Backlog\n\n- [>] [FEAT] Add login page\n- [ ] [FIX] Fix auth bug";
      writeFileSync(backlogPath, backlog);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", [
        "-c",
        `${harness}\nmark_in_backlog "- [>] [FEAT] Add login page" "- [x] [FEAT] Add login page"`,
      ]);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [x] [FEAT] Add login page");
      expect(content).not.toContain("- [>] [FEAT] Add login page");
    });

    it("marks claimed task with failure annotation", () => {
      const backlog =
        "# Backlog\n\n- [>] [FEAT] Add login page\n- [ ] [FIX] Fix auth bug";
      writeFileSync(backlogPath, backlog);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", [
        "-c",
        `${harness}\nmark_in_backlog "- [>] [FEAT] Add login page" "- [x] [FEAT] Add login page _(typecheck failed)_"`,
      ]);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain(
        "- [x] [FEAT] Add login page _(typecheck failed)_"
      );
    });

    it("does not modify other lines", () => {
      const backlog =
        "# Backlog\n\n- [>] [FEAT] Add login page\n- [ ] [FIX] Fix auth bug\n- [x] [FEAT] Setup project";
      writeFileSync(backlogPath, backlog);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", [
        "-c",
        `${harness}\nmark_in_backlog "- [>] [FEAT] Add login page" "- [x] [FEAT] Add login page"`,
      ]);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [ ] [FIX] Fix auth bug");
      expect(content).toContain("- [x] [FEAT] Setup project");
    });
  });

  // -----------------------------------------------------------------------
  // remove_from_backlog
  // -----------------------------------------------------------------------
  describe("remove_from_backlog", () => {
    it("removes a line by exact match", () => {
      const backlog =
        "# Backlog\n\n- [ ] [FEAT] Add login page\n- [ ] [FIX] Fix auth bug";
      writeFileSync(backlogPath, backlog);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", [
        "-c",
        `${harness}\nremove_from_backlog "- [ ] [FEAT] Add login page"`,
      ]);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).not.toContain("Add login page");
      expect(content).toContain("- [ ] [FIX] Fix auth bug");
    });

    it("keeps other lines intact", () => {
      const backlog =
        "# Backlog\n\n- [ ] [FEAT] Add login page\n- [ ] [FIX] Fix auth bug\n- [x] [FEAT] Setup project";
      writeFileSync(backlogPath, backlog);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      spawnSync("bash", [
        "-c",
        `${harness}\nremove_from_backlog "- [ ] [FEAT] Add login page"`,
      ]);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("# Backlog");
      expect(content).toContain("- [ ] [FIX] Fix auth bug");
      expect(content).toContain("- [x] [FEAT] Setup project");
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent worker scenarios
  // -----------------------------------------------------------------------
  describe("Concurrent worker scenarios", () => {
    it("two workers claim different tasks", () => {
      const backlog =
        "# Backlog\n\n- [ ] [FEAT] Task A\n- [ ] [FIX] Task B\n- [ ] [FEAT] Task C";
      writeFileSync(backlogPath, backlog);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      // Worker 1 claims
      const w1 = spawnSync("bash", [
        "-c",
        `${harness}\nclaim_next_task`,
      ]);
      // Worker 2 claims (sequentially, but tests same-backlog exclusion)
      const w2 = spawnSync("bash", [
        "-c",
        `${harness}\nclaim_next_task`,
      ]);

      const task1 = w1.stdout.toString().trim();
      const task2 = w2.stdout.toString().trim();

      expect(task1).toBe("- [ ] [FEAT] Task A");
      expect(task2).toBe("- [ ] [FIX] Task B");
      expect(task1).not.toBe(task2);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [>] [FEAT] Task A");
      expect(content).toContain("- [>] [FIX] Task B");
      expect(content).toContain("- [ ] [FEAT] Task C");
    });

    it("parallel workers don't claim the same task (race test)", () => {
      // Create backlog with many tasks to increase race window
      const tasks = Array.from({ length: 20 }, (_, i) => `- [ ] [FEAT] Task ${i + 1}`);
      writeFileSync(backlogPath, `# Backlog\n\n${tasks.join("\n")}`);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      // Write a script that two subshells execute concurrently
      const script = `${harness}
        claim1_file="${tmpDir}/claim1.txt"
        claim2_file="${tmpDir}/claim2.txt"

        # Launch two claim attempts concurrently
        (claim_next_task > "$claim1_file") &
        pid1=$!
        (claim_next_task > "$claim2_file") &
        pid2=$!

        wait $pid1
        wait $pid2

        cat "$claim1_file"
        echo "---"
        cat "$claim2_file"`;

      const result = spawnSync("bash", ["-c", script], { timeout: 15000 });
      const output = result.stdout.toString().trim();
      const [claim1, claim2] = output.split("---").map((s) => s.trim());

      // Both should have claimed something
      if (claim1 && claim2) {
        // If both succeeded, they must have different tasks
        expect(claim1).not.toBe(claim2);
      }
      // At minimum, at least one should have succeeded
      expect(claim1 || claim2).toBeTruthy();

      // Verify backlog integrity — no duplicate [>] markers for same task
      const content = readFileSync(backlogPath, "utf8");
      const claimedLines = content
        .split("\n")
        .filter((l) => l.startsWith("- [>]"));
      const claimedSet = new Set(claimedLines);
      expect(claimedLines.length).toBe(claimedSet.size);
    });

    it("cleanup_on_exit unclaims task for crashed worker", () => {
      const backlog =
        "# Backlog\n\n- [>] [FEAT] Crashed task\n- [ ] [FIX] Next task";
      writeFileSync(backlogPath, backlog);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      // Simulate cleanup_on_exit calling unclaim_task
      spawnSync("bash", [
        "-c",
        `${harness}\nunclaim_task "[FEAT] Crashed task"`,
      ]);

      const content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [ ] [FEAT] Crashed task");
      expect(content).not.toContain("- [>] [FEAT] Crashed task");
    });

    it("per-worker PID locks allow different worker IDs to run concurrently", () => {
      const lock1 = join(tmpDir, "worker-1.lock");
      const lock2 = join(tmpDir, "worker-2.lock");

      // Worker 1 is "running"
      writeFileSync(lock1, String(process.pid));

      // Worker 2 should be able to start (different lock file)
      const result = spawnSync("bash", [
        "-c",
        `LOCKFILE="${lock2}"
         if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
           echo "BLOCKED"
         else
           echo $$ > "$LOCKFILE"
           echo "STARTED"
           rm -f "$LOCKFILE"
         fi`,
      ]);
      expect(result.stdout.toString().trim()).toBe("STARTED");
    });

    it("same worker ID is blocked by existing live PID", () => {
      const lockfile = join(tmpDir, "worker-1.lock");

      // Worker 1 is "running" (our own PID)
      writeFileSync(lockfile, String(process.pid));

      const result = spawnSync("bash", [
        "-c",
        `LOCKFILE="${lockfile}"
         if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
           echo "BLOCKED"
         else
           echo $$ > "$LOCKFILE"
           echo "STARTED"
         fi`,
      ]);
      expect(result.stdout.toString().trim()).toBe("BLOCKED");
    });

    it("full claim-work-complete cycle", () => {
      const backlog =
        "# Backlog\n\n- [ ] [FEAT] Task A\n- [ ] [FIX] Task B";
      writeFileSync(backlogPath, backlog);
      const harness = shellHarness({ lockPrefix, backlog: backlogPath });

      // 1. Claim
      const claimed = spawnSync("bash", [
        "-c",
        `${harness}\nclaim_next_task`,
      ]).stdout.toString().trim();
      expect(claimed).toBe("- [ ] [FEAT] Task A");

      // 2. Verify claimed in backlog
      let content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [>] [FEAT] Task A");

      // 3. Mark complete
      spawnSync("bash", [
        "-c",
        `${harness}\nmark_in_backlog "- [>] [FEAT] Task A" "- [x] [FEAT] Task A"`,
      ]);

      // 4. Verify completed
      content = readFileSync(backlogPath, "utf8");
      expect(content).toContain("- [x] [FEAT] Task A");
      expect(content).toContain("- [ ] [FIX] Task B");

      // 5. Next claim should get Task B
      const next = spawnSync("bash", [
        "-c",
        `${harness}\nclaim_next_task`,
      ]).stdout.toString().trim();
      expect(next).toBe("- [ ] [FIX] Task B");
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a `touch -t` timestamp for N seconds in the past.
 * Format: YYYYMMDDhhmm.SS (for touch -t)
 */
function getOldTimestamp(secondsAgo: number): string {
  const d = new Date(Date.now() - secondsAgo * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}
