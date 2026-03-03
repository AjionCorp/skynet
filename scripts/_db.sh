#!/usr/bin/env bash
# _db.sh — SQLite database abstraction layer for Skynet pipeline
# Sourced by _config.sh. All functions wrap sqlite3 CLI calls.
# WAL mode handles concurrent reads + single writer — no more mkdir locks.

DB_PATH="${SKYNET_DEV_DIR}/skynet.db"
# Security: skynet.db is not encrypted. Ensure .dev/ directory is on an
# encrypted volume and has restrictive permissions (chmod 700).

# OPS-P0-2: WAL health flag — set to false after checkpoint failure so operators
# can observe degraded state. Does NOT block writes (too aggressive); purely
# for observability via watchdog logs and status surfaces.
_db_wal_healthy=true

# P0-WAL: Consecutive WAL checkpoint failure counter for circuit breaker.
# When >= 3, db_is_wal_healthy returns false and new task claims are blocked.
_db_wal_checkpoint_failures=0

# --- Temp file tracking for leak prevention ---
# mktemp files created by _sql_exec/_sql_query are normally cleaned inline,
# but a SIGTERM between mktemp and rm would leak them. _db_cleanup_tmpfiles()
# sweeps any survivors — callers with their own EXIT traps should call it.
# SIGKILL is uncatchable — leaked files use a fixed prefix so a cron job
# like `find /tmp -name 'skynet-sql-*' -mmin +60 -exec rm -f {} +` can clean up.
_DB_TMPFILES=""
_db_register_tmp() { _DB_TMPFILES="$_DB_TMPFILES $1"; }
_db_cleanup_tmpfiles() {
  local _f
  # Intentional word splitting: _DB_TMPFILES is a space-delimited string of paths.
  # We don't quote it because we need the shell to split on spaces.
  for _f in $_DB_TMPFILES; do
    rm -f "$_f" 2>/dev/null || true
  done
  _DB_TMPFILES=""
}

# Fail-fast guard: call at worker/fixer startup to ensure SQLite is available.
_require_db() {
  [ -f "$DB_PATH" ] || { log "FATAL: SQLite database missing at $DB_PATH — run 'skynet init' first"; exit 1; }
}

# Unit Separator (0x1F) for sqlite3 output — safe for fields containing pipes.
_DB_SEP=$'\x1f'

# --- SQL injection prevention ---
# Escapes single quotes for SQL string literals and strips NUL bytes (\0).
# SQLite does not support NUL bytes in TEXT fields — they silently truncate
# the value at the NUL position. Stripping them prevents data loss.
_sql_escape() { printf '%s\n' "$1" | tr -d '\0' | sed "s/'/''/g"; }
# NOTE: _sql_int intentionally coerces non-numeric input to 0 rather than
# failing. This is defense-in-depth — callers should validate inputs, but
# if invalid data reaches SQL, 0 is safer than an injection vector.
# Strip non-digits and leading zeros — defense-in-depth for integer params.
# Intentionally rejects negative values — all DB integer fields in skynet
# (worker IDs, counts, epochs) are non-negative.
_sql_int() {
  local v="${1%%[^0-9]*}"
  v="${v:-0}"
  echo $((10#$v + 0))
}

# Portable millisecond timer (macOS date lacks %N, use perl Time::HiRes)
_db_now_ms() {
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000' 2>/dev/null
  else
    echo 0
  fi
}

# --- sqlite3 with automatic busy_timeout (no output pollution) ---
# .timeout is a dot-command that sets busy_timeout without producing output.
_db_no_out() {
  _db "$@" >&2
}

_db() {
  if [ "${SKYNET_DB_DEBUG:-false}" = "true" ]; then
    local _start _end _elapsed _preview
    _start=$(_db_now_ms)
    local _out
    _out=$(sqlite3 -cmd ".timeout 15000" "$DB_PATH" "$1")
    local _rc=$?
    _end=$(_db_now_ms)
    if [ "$_start" -gt 0 ] && [ "$_end" -gt 0 ] 2>/dev/null; then
      _elapsed=$(( _end - _start ))
    else
      _elapsed="?"
    fi
    _preview=$(printf '%s' "$1" | head -3 | tr '\n' ' ' | cut -c1-200)
    log "SQL DEBUG (${_elapsed}ms rc=$_rc): $_preview" 2>/dev/null || true
    if [ "$_elapsed" != "?" ] && [ "$_elapsed" -gt "${SKYNET_DB_SLOW_QUERY_MS:-100}" ] 2>/dev/null; then
      log "SQL SLOW (${_elapsed}ms > ${SKYNET_DB_SLOW_QUERY_MS}ms): $_preview" 2>/dev/null || true
    fi
    [ -n "$_out" ] && printf '%s\n' "$_out"
    return $_rc
  fi
  sqlite3 -cmd ".timeout 15000" "$DB_PATH" "$1"
}

_db_sep() {
  if [ "${SKYNET_DB_DEBUG:-false}" = "true" ]; then
    local _start _end _elapsed _preview
    _start=$(_db_now_ms)
    local _out
    _out=$(sqlite3 -separator "$_DB_SEP" -cmd ".timeout 15000" "$DB_PATH" "$1")
    local _rc=$?
    _end=$(_db_now_ms)
    if [ "$_start" -gt 0 ] && [ "$_end" -gt 0 ] 2>/dev/null; then
      _elapsed=$(( _end - _start ))
    else
      _elapsed="?"
    fi
    _preview=$(printf '%s' "$1" | head -3 | tr '\n' ' ' | cut -c1-200)
    log "SQL DEBUG (${_elapsed}ms rc=$_rc): $_preview" 2>/dev/null || true
    if [ "$_elapsed" != "?" ] && [ "$_elapsed" -gt "${SKYNET_DB_SLOW_QUERY_MS:-100}" ] 2>/dev/null; then
      log "SQL SLOW (${_elapsed}ms > ${SKYNET_DB_SLOW_QUERY_MS}ms): $_preview" 2>/dev/null || true
    fi
    [ -n "$_out" ] && printf '%s\n' "$_out"
    return $_rc
  fi
  sqlite3 -separator "$_DB_SEP" -cmd ".timeout 15000" "$DB_PATH" "$1"
}

# --- Error-checked sqlite3 wrapper for mutations ---
# Usage: _sql_exec "SQL statement"
# Logs to stderr and returns 1 on failure.
_sql_exec() {
  local _sql_out="" _sql_rc _sql_errfile
  _sql_errfile=$(mktemp /tmp/skynet-sql-err-XXXXXX)
  _db_register_tmp "$_sql_errfile"
  # Capture stdout into variable, send stderr to file for error checking
  _sql_out=$(_db "$1" 2>"$_sql_errfile")
  _sql_rc=$?
  local _sql_err=""
  [ -f "$_sql_errfile" ] && _sql_err=$(cat "$_sql_errfile" 2>/dev/null)
  rm -f "$_sql_errfile"
  if [ $_sql_rc -ne 0 ]; then
    [ -n "$_sql_err" ] && log "SQL ERROR: $_sql_err"
    log "SQL FAILED (rc=$_sql_rc): $(echo "$1" | head -1)"
    return 1
  fi
  # Echo clean output back to stdout for callers that capture it
  [ -n "$_sql_out" ] && echo "$_sql_out"
}

# Error-checked sqlite3 wrapper that returns pipe-delimited rows.
_sql_query() {
  local _sql_out="" _sql_rc _sql_errfile
  _sql_errfile=$(mktemp /tmp/skynet-sql-query-err-XXXXXX)
  _db_register_tmp "$_sql_errfile"
  # Capture stdout into variable, send stderr to file for error checking
  _sql_out=$(_db_sep "$1" 2>"$_sql_errfile")
  _sql_rc=$?
  local _sql_err=""
  [ -f "$_sql_errfile" ] && _sql_err=$(cat "$_sql_errfile" 2>/dev/null)
  rm -f "$_sql_errfile"
  if [ $_sql_rc -ne 0 ]; then
    [ -n "$_sql_err" ] && log "SQL QUERY ERROR: $_sql_err"
    log "SQL QUERY FAILED (rc=$_sql_rc): $(echo "$1" | head -1)"
    return 1
  fi
  # Echo clean output back to stdout for callers that capture it
  [ -n "$_sql_out" ] && echo "$_sql_out"
}

# ============================================================
# STATUS TRANSITION VALIDATION
# ============================================================

# Valid status transitions (state machine):
#   pending    → claimed, superseded, done
#   claimed    → completed, pending (unclaim), failed
#   failed     → fixing-N, pending (reset), superseded, blocked
#   fixing-N   → failed, completed
#   blocked    → pending (unblock), superseded
#   completed  → (terminal)
#   superseded → (terminal)
#   done       → (terminal)
#   done       → (terminal)
#
# This is an audit-only guard: logs a WARNING on unexpected transitions
# but does NOT block the operation. Non-breaking by design.

_validate_status_transition() {
  local task_id="$1"
  local from_status="$2"
  local to_status="$3"
  local caller="${4:-unknown}"

  # Empty from_status means we couldn't determine it — skip validation
  [ -z "$from_status" ] && return 0

  local valid=false

  case "$from_status" in
    pending)
      case "$to_status" in
        claimed|superseded|done) valid=true ;;
      esac
      ;;
    claimed)
      case "$to_status" in
        completed|pending|failed) valid=true ;;
      esac
      ;;
    failed)
      case "$to_status" in
        pending|superseded|blocked) valid=true ;;
        fixing-*) valid=true ;;
      esac
      ;;
    fixing-*)
      case "$to_status" in
        failed|completed) valid=true ;;
      esac
      ;;
    blocked)
      case "$to_status" in
        pending|superseded) valid=true ;;
      esac
      ;;
    completed|superseded|done)
      # Terminal states — no valid transitions out
      # Exception: completed → failed is used by smoke test revert (post-merge)
      case "$to_status" in
        failed) valid=true ;;
      esac
      ;;
  esac

  if ! $valid; then
    log "WARNING: Unexpected status transition for task $task_id: '$from_status' → '$to_status' (caller: $caller)" 2>/dev/null || true
  fi

  return 0
}

# Helper: look up current status of a task by ID for transition validation.
# Returns the status string, empty if not found, or "ERROR" (with rc=1) on SQL failure.
_get_task_status() {
  local task_id; task_id=$(_sql_int "$1")
  local result
  result=$(_db "SELECT status FROM tasks WHERE id=$task_id;" 2>/dev/null)
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "ERROR"
    return 1
  fi
  echo "$result"
}

# ============================================================
# DISK SPACE CHECK
# ============================================================

# OPS-P0-2: Check available disk space before writes.
# Returns 0 if OK, 1 if below threshold (SKYNET_MIN_DISK_MB).
_db_check_disk_space() {
  local min_mb="${SKYNET_MIN_DISK_MB:-100}"
  local db_dir
  db_dir=$(dirname "$DB_PATH")
  # df -Pm gives POSIX output in 1MB blocks; skip header with tail.
  local avail_mb
  avail_mb=$(df -Pm "$db_dir" 2>/dev/null | tail -1 | awk '{print $4}')
  if [ -n "$avail_mb" ] && [ "$avail_mb" -lt "$min_mb" ] 2>/dev/null; then
    log "CRITICAL: Low disk space — ${avail_mb}MB available, minimum ${min_mb}MB required for DB writes" 2>/dev/null || \
      echo "CRITICAL: Low disk space — ${avail_mb}MB available, minimum ${min_mb}MB required" >&2
    return 1
  fi

  # OPS-P2-5: Check WAL growth pressure — if WAL is already >50MB and free space <200MB,
  # warn about potential disk exhaustion under write-heavy load (WAL can grow 10MB/min).
  local _wal_file="${DB_PATH}-wal"
  if [ -f "$_wal_file" ]; then
    local _wal_bytes
    _wal_bytes=$(wc -c < "$_wal_file" 2>/dev/null || echo 0)
    local _wal_mb=$(( _wal_bytes / 1048576 ))
    if [ "$_wal_mb" -gt 50 ] && [ -n "$avail_mb" ] && [ "$avail_mb" -lt 200 ] 2>/dev/null; then
      log "WARNING: WAL growth pressure — WAL is ${_wal_mb}MB and only ${avail_mb}MB free. WAL can grow 10MB/min under load." 2>/dev/null || \
        echo "WARNING: WAL growth pressure — WAL is ${_wal_mb}MB and only ${avail_mb}MB free" >&2
    fi
  fi

  return 0
}

# ============================================================
# INITIALIZATION
# ============================================================

db_init() {
  _db_check_disk_space || true
  [ -f "$DB_PATH" ] || true  # sqlite3 creates if missing
  local _init_err
  _init_err=$(sqlite3 "$DB_PATH" <<'SCHEMA' 2>&1
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 15000;

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

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_normalized_root ON tasks(normalized_root);
CREATE INDEX IF NOT EXISTS idx_tasks_branch ON tasks(branch);
CREATE INDEX IF NOT EXISTS idx_tasks_status_worker ON tasks(status, worker_id);
CREATE INDEX IF NOT EXISTS idx_tasks_nroot_status ON tasks(normalized_root, status) WHERE normalized_root != '';

CREATE TABLE IF NOT EXISTS blockers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  task_title  TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_blockers_status ON blockers(status);

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

CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch       INTEGER NOT NULL,
  event       TEXT NOT NULL,
  detail      TEXT DEFAULT '',
  worker_id   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_epoch ON events(epoch);
CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);

CREATE TABLE IF NOT EXISTS fixer_stats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch       INTEGER NOT NULL,
  result      TEXT NOT NULL,
  task_title  TEXT NOT NULL,
  fixer_id    INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fixer_stats_epoch ON fixer_stats(epoch);

CREATE TABLE IF NOT EXISTS _metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO _metadata (key, value) VALUES ('schema_version', '1');
SCHEMA
  )
  local _init_rc=$?
  if [ $_init_rc -ne 0 ]; then
    echo "FATAL: db_init failed (rc=$_init_rc): $_init_err" >&2
    exit 1
  fi

  # Schema migrations — add columns that may not exist in older databases
  _db_no_out "ALTER TABLE workers ADD COLUMN progress_epoch INTEGER;" 2>/dev/null || true
  _db_no_out "ALTER TABLE tasks ADD COLUMN trace_id TEXT DEFAULT '';" 2>/dev/null || true
  _db_no_out "ALTER TABLE events ADD COLUMN trace_id TEXT DEFAULT '';" 2>/dev/null || true
  _db_no_out "ALTER TABLE tasks ADD COLUMN mission_hash TEXT DEFAULT '';" 2>/dev/null || true
  _db_no_out "CREATE INDEX IF NOT EXISTS idx_tasks_mission_status ON tasks(mission_hash, status);" 2>/dev/null || true

  # Periodic WAL checkpoint — truncate the WAL file to reclaim disk space.
  # Safe to run on every init; TRUNCATE waits for readers to finish and is a no-op
  # if the WAL is already empty. Prevents unbounded WAL growth from concurrent workers.
  _db_no_out "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true

  # Recursive CTEs require SQLite 3.8.3+ (2014). macOS ships 3.39+, Linux CI has latest.
  local _sqlite_ver
  _sqlite_ver=$(sqlite3 --version 2>/dev/null | cut -d' ' -f1 || echo "0.0.0")
  local _major _minor _patch
  _major=$(echo "$_sqlite_ver" | cut -d. -f1)
  _minor=$(echo "$_sqlite_ver" | cut -d. -f2)
  _patch=$(echo "$_sqlite_ver" | cut -d. -f3)
  if [ "${_major:-0}" -lt 3 ] || { [ "${_major:-0}" -eq 3 ] && [ "${_minor:-0}" -lt 9 ]; }; then
    echo "WARNING: SQLite $_sqlite_ver detected; Skynet requires 3.9+ for recursive CTEs" >&2
  fi
}

# ============================================================
# TASK CRUD
# ============================================================

# Used by tests; production uses db_claim_next_task() instead
# Output: pipe-delimited rows: id|title|tag|description|blocked_by|priority
db_get_pending_tasks() {
  _db_sep \
    "SELECT id, title, tag, description, blocked_by, priority FROM tasks WHERE status = 'pending' ORDER BY priority ASC;"
}

db_count_pending() {
  _db "SELECT COUNT(*) FROM tasks WHERE status = 'pending';"
}

db_count_claimed() {
  _db "SELECT COUNT(*) FROM tasks WHERE status = 'claimed';"
}

db_count_by_status() {
  local status; status=$(_sql_escape "$1")
  _db "SELECT COUNT(*) FROM tasks WHERE status = '$status';"
}

# --- Mission-filtered counts (for project-driver backlog isolation) ---

db_count_pending_for_mission() {
  local hash; hash=$(_sql_escape "$1")
  _db "SELECT COUNT(*) FROM tasks WHERE status='pending' AND mission_hash='$hash';"
}

db_count_claimed_for_mission() {
  local hash; hash=$(_sql_escape "$1")
  _db "SELECT COUNT(*) FROM tasks WHERE status='claimed' AND mission_hash='$hash';"
}

# Supersede pending tasks from old missions. Returns count of superseded tasks.
# Only affects pending tasks — claimed (in-flight) tasks are left alone.
db_supersede_old_mission_tasks() {
  local hash; hash=$(_sql_escape "$1")
  _db "
    UPDATE tasks SET status='superseded', notes='mission changed', updated_at=datetime('now')
    WHERE status='pending' AND mission_hash != '$hash' AND mission_hash != '';
    SELECT changes();
  "
}

# Backfill mission_hash for existing tasks that predate this feature.
# Tags pending/claimed tasks with the given hash if they have no hash set.
db_backfill_mission_hash() {
  local hash; hash=$(_sql_escape "$1")
  _db "UPDATE tasks SET mission_hash='$hash' WHERE mission_hash='' AND status IN ('pending','claimed');"
}

# --- Metadata key-value helpers ---

db_get_metadata() {
  local key; key=$(_sql_escape "$1")
  _db "SELECT value FROM _metadata WHERE key='$key';"
}

db_set_metadata() {
  local key; key=$(_sql_escape "$1")
  local val; val=$(_sql_escape "$2")
  _db "INSERT OR REPLACE INTO _metadata (key, value) VALUES ('$key', '$val');"
}

# --- Retry wrapper for critical mutations under SQLITE_BUSY ---
# Retries a function up to 3 times with jitter on failure.
# Usage: _db_retry <function_name> [args...]
_db_retry() {
  local func="$1"; shift
  local attempt=1
  local max_attempts=3
  local rc=0
  local output=""
  while [ "$attempt" -le "$max_attempts" ]; do
    output=$("$func" "$@") && rc=0 || rc=$?
    if [ "$rc" -eq 0 ]; then
      [ -n "$output" ] && printf '%s\n' "$output"
      return 0
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      local jitter=$(( RANDOM % 3 + 1 ))
      log "RETRY: $func failed (attempt $attempt/$max_attempts), retrying in ${jitter}s..." 2>/dev/null || true
      sleep "$jitter"
    fi
    attempt=$((attempt + 1))
  done
  [ -n "$output" ] && printf '%s\n' "$output"
  return "$rc"
}

# blocked_by values are stored as comma-separated task titles (CSV format).
# This is enforced by addTask() in both TS and bash layers.
# The dep_split CTE below relies on this format — do NOT change the separator.
#
# Find + atomically claim the next unblocked pending task for a worker.
# Output: id|title|tag|description|branch  or empty string if none available.
# Uses a single SQL statement with BEGIN IMMEDIATE + recursive CTE to resolve
# blocker dependencies and claim atomically — no race window between check and claim.
_db_claim_next_task_inner() {
  local worker_id; worker_id=$(_sql_int "$1")

  # ── Claim Algorithm ──────────────────────────────────────────────
  # Single atomic SQL that finds and claims the next eligible task:
  #   1. BEGIN IMMEDIATE — acquires RESERVED lock (serializes writers)
  #   2. dep_split CTE — recursively splits comma-separated blocked_by
  #      into individual dependency titles ("A, B" → ["A", "B"])
  #   3. unresolved CTE — finds tasks with dependencies NOT yet in
  #      terminal state (completed/done/fixed/superseded)
  #   4. target CTE — selects highest-priority pending task that is
  #      either unblocked or has all dependencies resolved
  #   5. UPDATE + SELECT — atomically claims the target and returns
  #      task details inside the same transaction (P0-1 fix: prevents
  #      another worker from modifying the task between COMMIT and SELECT)
  # ─────────────────────────────────────────────────────────────────
  # P0-1: The SELECT now runs INSIDE the transaction, before COMMIT.
  # Previously, the SELECT ran after COMMIT in a separate query, creating
  # a race window where another worker could modify the claimed task.
  _db_sep "
    BEGIN IMMEDIATE;
    WITH RECURSIVE dep_split(task_id, dep, rest) AS (
      SELECT id,
        TRIM(SUBSTR(blocked_by, 1, INSTR(blocked_by || ',', ',') - 1)),
        SUBSTR(blocked_by, INSTR(blocked_by || ',', ',') + 1)
      FROM tasks WHERE status = 'pending' AND blocked_by != ''
      UNION ALL
      SELECT task_id,
        TRIM(SUBSTR(rest, 1, INSTR(rest || ',', ',') - 1)),
        SUBSTR(rest, INSTR(rest || ',', ',') + 1)
      FROM dep_split WHERE rest != ''
    ),
    unresolved AS (
      SELECT DISTINCT task_id FROM dep_split
      WHERE dep IS NOT NULL AND dep != ''
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.title = dep_split.dep
            AND t.status IN ('completed', 'done', 'fixed', 'superseded')
        )
    ),
    target AS (
      SELECT id FROM tasks
      WHERE status = 'pending'
        AND (blocked_by = '' OR blocked_by IS NULL OR id NOT IN (SELECT task_id FROM unresolved))
      ORDER BY priority ASC
      LIMIT 1
    )
    UPDATE tasks SET status = 'claimed', worker_id = $worker_id,
      claimed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = (SELECT id FROM target) AND status = 'pending';
    SELECT id, title, tag, description, branch FROM tasks
      WHERE worker_id = $worker_id AND status = 'claimed'
      ORDER BY claimed_at DESC LIMIT 1;
    COMMIT;
  "
}
db_claim_next_task() {
  if ! db_is_wal_healthy; then
    log "WARNING: task claim blocked — WAL checkpoint has failed 3+ consecutive cycles, database degraded"
    return 0
  fi
  _db_retry _db_claim_next_task_inner "$@"
}

# Mission-filtered variant: same claim logic but restricts to tasks with matching mission_hash.
# Used when a worker is assigned to a specific mission via _config.json.
_db_claim_next_task_for_mission_inner() {
  local worker_id; worker_id=$(_sql_int "$1")
  local mhash; mhash=$(_sql_escape "$2")

  _db_sep "
    BEGIN IMMEDIATE;
    WITH RECURSIVE dep_split(task_id, dep, rest) AS (
      SELECT id,
        TRIM(SUBSTR(blocked_by, 1, INSTR(blocked_by || ',', ',') - 1)),
        SUBSTR(blocked_by, INSTR(blocked_by || ',', ',') + 1)
      FROM tasks WHERE status = 'pending' AND blocked_by != '' AND mission_hash = '$mhash'
      UNION ALL
      SELECT task_id,
        TRIM(SUBSTR(rest, 1, INSTR(rest || ',', ',') - 1)),
        SUBSTR(rest, INSTR(rest || ',', ',') + 1)
      FROM dep_split WHERE rest != ''
    ),
    unresolved AS (
      SELECT DISTINCT task_id FROM dep_split
      WHERE dep IS NOT NULL AND dep != ''
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.title = dep_split.dep
            AND t.status IN ('completed', 'done', 'fixed', 'superseded')
        )
    ),
    target AS (
      SELECT id FROM tasks
      WHERE status = 'pending' AND mission_hash = '$mhash'
        AND (blocked_by = '' OR blocked_by IS NULL OR id NOT IN (SELECT task_id FROM unresolved))
      ORDER BY priority ASC
      LIMIT 1
    )
    UPDATE tasks SET status = 'claimed', worker_id = $worker_id,
      claimed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = (SELECT id FROM target) AND status = 'pending';
    SELECT id, title, tag, description, branch FROM tasks
      WHERE worker_id = $worker_id AND status = 'claimed'
      ORDER BY claimed_at DESC LIMIT 1;
    COMMIT;
  "
}
db_claim_next_task_for_mission() {
  if ! db_is_wal_healthy; then
    log "WARNING: task claim blocked — WAL checkpoint has failed 3+ consecutive cycles, database degraded"
    return 0
  fi
  _db_retry _db_claim_next_task_for_mission_inner "$@"
}

# Diagnostic: show query plan for the claim CTE.
# Usage: db_explain_claim 1
db_explain_claim() {
  local worker_id; worker_id=$(_sql_int "$1")
  _db "
    EXPLAIN QUERY PLAN
    WITH RECURSIVE dep_split(task_id, dep, rest) AS (
      SELECT id,
        TRIM(SUBSTR(blocked_by, 1, INSTR(blocked_by || ',', ',') - 1)),
        SUBSTR(blocked_by, INSTR(blocked_by || ',', ',') + 1)
      FROM tasks WHERE status = 'pending' AND blocked_by != ''
      UNION ALL
      SELECT task_id,
        TRIM(SUBSTR(rest, 1, INSTR(rest || ',', ',') - 1)),
        SUBSTR(rest, INSTR(rest || ',', ',') + 1)
      FROM dep_split WHERE rest != ''
    ),
    unresolved AS (
      SELECT DISTINCT task_id FROM dep_split
      WHERE dep IS NOT NULL AND dep != ''
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.title = dep_split.dep
            AND t.status IN ('completed', 'done', 'fixed', 'superseded')
        )
    ),
    target AS (
      SELECT id FROM tasks
      WHERE status = 'pending'
        AND (blocked_by = '' OR blocked_by IS NULL OR id NOT IN (SELECT task_id FROM unresolved))
      ORDER BY priority ASC
      LIMIT 1
    )
    SELECT * FROM target;
  "
}

db_unclaim_task() {
  local task_id; task_id=$(_sql_int "$1")
  local _cur_status; _cur_status=$(_get_task_status "$task_id" 2>/dev/null || true)
  [ "$_cur_status" != "ERROR" ] && _validate_status_transition "$task_id" "$_cur_status" "pending" "db_unclaim_task"
  _sql_exec "
    UPDATE tasks SET status='pending', worker_id=NULL, claimed_at=NULL, updated_at=datetime('now')
    WHERE id=$task_id AND status='claimed';
  "
}

db_unclaim_task_by_title() {
  local title; title=$(_sql_escape "$1")
  _sql_exec "
    UPDATE tasks SET status='pending', worker_id=NULL, claimed_at=NULL, updated_at=datetime('now')
    WHERE title='$title' AND status='claimed';
  "
}

# Unclaim all claimed tasks (used for mission switches or emergency resets).
# Returns number of tasks updated.
db_unclaim_all_tasks() {
  _db "
    UPDATE tasks SET status='pending', worker_id=NULL, claimed_at=NULL, updated_at=datetime('now')
    WHERE status='claimed';
    SELECT changes();
  "
}

# Complete a task (successful merge)
_db_complete_task_inner() {
  local task_id; task_id=$(_sql_int "$1")
  local branch="$2" duration="$3" duration_secs; duration_secs=$(_sql_int "${4:-0}")
  local notes="${5:-success}"
  local _cur_status; _cur_status=$(_get_task_status "$task_id" 2>/dev/null || true)
  [ "$_cur_status" != "ERROR" ] && _validate_status_transition "$task_id" "$_cur_status" "completed" "db_complete_task"
  local branch_esc; branch_esc=$(_sql_escape "$branch")
  local duration_esc; duration_esc=$(_sql_escape "$duration")
  local notes_esc; notes_esc=$(_sql_escape "$notes")
  _sql_exec "
    UPDATE tasks SET status='completed', branch='$branch_esc',
      duration='$duration_esc', duration_secs=$duration_secs, notes='$notes_esc',
      completed_at=datetime('now'), updated_at=datetime('now')
    WHERE id=$task_id AND status='claimed';
  "
}
db_complete_task() { _db_retry _db_complete_task_inner "$@"; }

# Record task failure
_db_fail_task_inner() {
  local task_id; task_id=$(_sql_int "$1")
  local branch="$2" error="$3"
  local _cur_status; _cur_status=$(_get_task_status "$task_id" 2>/dev/null || true)
  [ "$_cur_status" != "ERROR" ] && _validate_status_transition "$task_id" "$_cur_status" "failed" "db_fail_task"
  local branch_esc; branch_esc=$(_sql_escape "$branch")
  local error_esc; error_esc=$(_sql_escape "$error")
  _sql_exec "
    UPDATE tasks SET status='failed', branch='$branch_esc', error='$error_esc',
      failed_at=datetime('now'), updated_at=datetime('now')
    WHERE id=$task_id AND (status='claimed' OR status LIKE 'fixing-%' OR status='completed');
  "
}
db_fail_task() { _db_retry _db_fail_task_inner "$@"; }

# Add a new task. Echoes the new task ID.
# Args: title [tag] [desc] [position] [blocked_by] [mission_hash]
db_add_task() {
  local title="$1" tag="${2:-FEAT}" desc="${3:-}" position="${4:-top}" blocked_by="${5:-}" mission_hash="${6:-}"
  local title_esc; title_esc=$(_sql_escape "$title")
  local tag_esc; tag_esc=$(_sql_escape "$tag")
  local desc_esc; desc_esc=$(_sql_escape "$desc")
  local blocked_esc; blocked_esc=$(_sql_escape "$blocked_by")
  local mhash_esc; mhash_esc=$(_sql_escape "$mission_hash")
  local norm_root
  norm_root=$(echo "$title" | sed 's/\[[A-Z]*\] *//g' | tr '[:upper:]' '[:lower:]' | sed 's/  */ /g;s/^ *//;s/ *$//' | cut -c1-120)
  # SH-P2-8: Capture _sql_escape result before embedding in SQL string
  local norm_root_esc; norm_root_esc=$(_sql_escape "$norm_root")

  if [ "$position" = "top" ]; then
    _db "
      BEGIN IMMEDIATE;
      UPDATE tasks SET priority=priority+1 WHERE status IN ('pending','claimed');
      INSERT INTO tasks (title, tag, description, status, blocked_by, normalized_root, priority, mission_hash)
      VALUES ('$title_esc', '$tag_esc', '$desc_esc', 'pending', '$blocked_esc', '$norm_root_esc', 0, '$mhash_esc');
      SELECT last_insert_rowid();
      COMMIT;
    "
  else
    # Atomic subquery avoids TOCTOU: a separate SELECT MAX(priority) followed by
    # INSERT could race with another worker inserting between the two statements.
    _db "
      INSERT INTO tasks (title, tag, description, status, blocked_by, normalized_root, priority, mission_hash)
      VALUES ('$title_esc', '$tag_esc', '$desc_esc', 'pending', '$blocked_esc', '$norm_root_esc',
              (SELECT COALESCE(MAX(priority),0)+1 FROM tasks WHERE status IN ('pending','claimed')), '$mhash_esc');
      SELECT last_insert_rowid();
    "
  fi
}

# Mark a backlog task as done (the [x] equivalent — task was completed elsewhere)
db_mark_done() {
  local task_id; task_id=$(_sql_int "$1")
  _db "UPDATE tasks SET status='done', updated_at=datetime('now') WHERE id=$task_id AND status='pending';"
}

# Get task ID by title (exact match). Returns id or empty.
db_get_task_id_by_title() {
  local title; title=$(_sql_escape "$1")
  _db "SELECT id FROM tasks WHERE TRIM(title)=TRIM('$title') ORDER BY id DESC LIMIT 1;"
}

# Get task row by ID. Output: id|title|tag|status|branch|error|attempts
db_get_task() {
  local task_id; task_id=$(_sql_int "$1")
  _db_sep \
    "SELECT id, title, tag, status, branch, error, attempts FROM tasks WHERE id=$task_id;"
}

# ============================================================
# TRACE ID
# ============================================================

db_set_trace_id() {
  local task_id="$1" trace_id="$2"
  _db "UPDATE tasks SET trace_id='$(_sql_escape "$trace_id")' WHERE id=$(_sql_int "$task_id");"
}

db_get_trace_id() {
  local task_id="$1"
  _db "SELECT trace_id FROM tasks WHERE id=$(_sql_int "$task_id");"
}

# ============================================================
# FAILURE MANAGEMENT
# ============================================================

# Output: id|title|branch|error|attempts|status (oldest first)
db_get_pending_failures() {
  _db_sep \
    "SELECT id, title, branch, error, attempts, status FROM tasks WHERE status='failed' ORDER BY failed_at ASC;"
}

_db_claim_failure_inner() {
  local task_id; task_id=$(_sql_int "$1")
  local fixer_id; fixer_id=$(_sql_int "$2")
  # fixer_id is already sanitized to digits-only by _sql_int — no need for _sql_escape
  local changed
  changed=$(_db "
    UPDATE tasks SET status='fixing-$fixer_id', fixer_id=$fixer_id, updated_at=datetime('now')
    WHERE id=$task_id AND status='failed';
    SELECT changes();
  ")
  [ "$changed" = "1" ] && return 0 || return 1
}
db_claim_failure() { _db_retry _db_claim_failure_inner "$@"; }

db_unclaim_failure() {
  local task_id; task_id=$(_sql_int "$1")
  local fixer_id; fixer_id=$(_sql_int "$2")
  _sql_exec "UPDATE tasks SET status='failed', fixer_id=NULL, updated_at=datetime('now') WHERE id=$task_id AND status='fixing-$fixer_id';"
}

db_update_failure() {
  case "$4" in
    failed|blocked|fixing-*) ;;
    *) log "ERROR: invalid status '$4' for db_update_failure"; return 1 ;;
  esac
  local task_id; task_id=$(_sql_int "$1")
  local error="$2"
  local attempts; attempts=$(_sql_int "$3")
  local status="$4"
  local error_esc; error_esc=$(_sql_escape "$error")
  local status_esc; status_esc=$(_sql_escape "$status")
  _sql_exec "
    UPDATE tasks SET error='$error_esc', attempts=$attempts, status='$status_esc', updated_at=datetime('now')
    WHERE id=$task_id;
  "
}

db_fix_task() {
  local task_id; task_id=$(_sql_int "$1")
  local branch="$2"
  local attempts; attempts=$(_sql_int "$3")
  local error="${4:-}"
  local branch_esc; branch_esc=$(_sql_escape "$branch")
  local error_esc; error_esc=$(_sql_escape "$error")
  _sql_exec "
    UPDATE tasks SET status='fixed', branch='$branch_esc', attempts=$attempts, error='$error_esc',
      completed_at=datetime('now'), updated_at=datetime('now')
    WHERE id=$task_id AND (status='failed' OR status LIKE 'fixing-%');
  "
}

db_block_task() {
  local task_id; task_id=$(_sql_int "$1")
  _sql_exec "UPDATE tasks SET status='blocked', updated_at=datetime('now') WHERE id=$task_id AND (status='failed' OR status LIKE 'fixing-%');"
}

db_supersede_task() {
  local task_id; task_id=$(_sql_int "$1")
  _sql_exec "UPDATE tasks SET status='superseded', updated_at=datetime('now') WHERE id=$task_id;"
  # Resolve any blockers associated with this task
  local _title
  _title=$(_db "SELECT title FROM tasks WHERE id=$task_id;" 2>/dev/null || true)
  if [ -n "$_title" ]; then
    local _title_esc; _title_esc=$(_sql_escape "$_title")
    _db "UPDATE blockers SET status='resolved', resolved_at=datetime('now') WHERE task_title='$_title_esc' AND status='active';" 2>/dev/null || true
  fi
}

# Auto-supersede failed tasks matching completed roots. Returns count of changes.
# Also resolves orphaned blockers linked to newly-superseded tasks.
# Both UPDATEs are wrapped in a single transaction for atomicity.
# Returns a single number (task changes) — the caller in watchdog.sh expects one number.
#
# SH-P3-4: The subquery `SELECT normalized_root FROM tasks WHERE status IN
# ('completed','fixed') AND normalized_root != ''` is duplicated in both UPDATE
# statements. This is intentional for simplicity — the tasks table is small
# (typically < 200 rows), so the cost of re-running the subquery is negligible
# compared to the complexity of a CTE or temp table approach in sqlite3 CLI.
db_auto_supersede_completed() {
  _db "
    BEGIN IMMEDIATE;
    UPDATE blockers SET status='resolved', resolved_at=datetime('now')
    WHERE status='active' AND task_title IN (
      SELECT title FROM tasks
      WHERE (status='failed' OR status LIKE 'fixing-%') AND normalized_root != '' AND normalized_root IN (
        SELECT normalized_root FROM tasks WHERE status IN ('completed','fixed') AND normalized_root != ''
      )
    );
    UPDATE tasks SET status='superseded', updated_at=datetime('now')
    WHERE (status='failed' OR status LIKE 'fixing-%') AND normalized_root != '' AND normalized_root IN (
      SELECT normalized_root FROM tasks WHERE status IN ('completed','fixed') AND normalized_root != ''
    );
    SELECT changes();
    COMMIT;
  "
}

# ============================================================
# WORKER STATUS
# ============================================================

db_set_worker_status() {
  local wid; wid=$(_sql_int "$1")
  local wtype="$2" status="$3"
  local task_id_val="NULL"
  [ -n "${4:-}" ] && task_id_val=$(_sql_int "$4")
  local title="${5:-}" branch="${6:-}"
  local wtype_esc; wtype_esc=$(_sql_escape "$wtype")
  local status_esc; status_esc=$(_sql_escape "$status")
  local title_esc; title_esc=$(_sql_escape "$title")
  local branch_esc; branch_esc=$(_sql_escape "$branch")
  local started_val="NULL"
  [ "$status" = "in_progress" ] && started_val="datetime('now')"
  _sql_exec "
    INSERT INTO workers (id, worker_type, status, current_task_id, task_title, branch, started_at, updated_at)
    VALUES ($wid, '$wtype_esc', '$status_esc', $task_id_val, '$title_esc', '$branch_esc', $started_val, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      worker_type='$wtype_esc', status='$status_esc', current_task_id=$task_id_val,
      task_title='$title_esc', branch='$branch_esc',
      started_at=$started_val, updated_at=datetime('now');
  "
}

db_set_worker_idle() {
  local wid; wid=$(_sql_int "$1")
  local info="${2:-}"
  local info_esc; info_esc=$(_sql_escape "$info")
  _sql_exec "
    INSERT INTO workers (id, status, task_title, branch, started_at, last_info, updated_at)
    VALUES ($wid, 'idle', '', '', NULL, '$info_esc', datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      status='idle', current_task_id=NULL, task_title='', branch='',
      started_at=NULL, last_info='$info_esc', updated_at=datetime('now');
  "
}

db_update_heartbeat() {
  local wid; wid=$(_sql_int "$1")
  local epoch; epoch=$(date +%s)
  _sql_exec "
    INSERT INTO workers (id, heartbeat_epoch, updated_at)
    VALUES ($wid, $epoch, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET heartbeat_epoch=$epoch, updated_at=datetime('now');
  "
}

# Update progress epoch — called from the main worker loop (not the heartbeat
# subshell) to prove the worker is making forward progress, not hung.
db_update_progress() {
  local wid; wid=$(_sql_int "$1")
  local epoch; epoch=$(date +%s)
  _sql_exec "
    INSERT INTO workers (id, progress_epoch, updated_at)
    VALUES ($wid, $epoch, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET progress_epoch=$epoch, updated_at=datetime('now');
  "
}

# Combined heartbeat + progress update in single write transaction.
# Reduces write contention by coalescing two separate writes into one.
# Called by heartbeat subshell to halve the DB write frequency.
db_update_heartbeat_and_progress() {
  local wid; wid=$(_sql_int "$1")
  local epoch; epoch=$(date +%s)
  _sql_exec "
    INSERT INTO workers (id, heartbeat_epoch, progress_epoch, updated_at)
    VALUES ($wid, $epoch, $epoch, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      heartbeat_epoch=$epoch, progress_epoch=$epoch, updated_at=datetime('now');
  "
}

# Output: id|worker_type|status|current_task_id|task_title|branch|started_at|heartbeat_epoch|last_info
db_get_worker_status() {
  local wid; wid=$(_sql_int "$1")
  _db_sep \
    "SELECT id, worker_type, status, current_task_id, task_title, branch, started_at, heartbeat_epoch, last_info
     FROM workers WHERE id=$wid;"
}

# Output: id|heartbeat_epoch|age_secs (one per stale worker)
db_get_stale_heartbeats() {
  local stale_secs; stale_secs=$(_sql_int "$1")
  local max_workers; max_workers=$(_sql_int "${2:-9999}")
  local now; now=$(date +%s)
  _db_sep \
    "SELECT id, heartbeat_epoch, ($now - heartbeat_epoch) as age_secs
     FROM workers
     WHERE heartbeat_epoch IS NOT NULL AND heartbeat_epoch > 0
       AND ($now - heartbeat_epoch) > $stale_secs
       AND id <= $max_workers;"
}

# Detect hung workers: heartbeat is fresh (subshell alive) but progress is stale
# (main loop stuck). Returns id|progress_epoch|age_secs for hung workers.
db_get_hung_workers() {
  local stale_secs; stale_secs=$(_sql_int "$1")
  local now; now=$(date +%s)
  _db_sep \
    "SELECT id, progress_epoch, ($now - progress_epoch) as age_secs
     FROM workers
     WHERE status = 'in_progress'
       AND heartbeat_epoch IS NOT NULL AND ($now - heartbeat_epoch) <= $stale_secs
       AND progress_epoch IS NOT NULL AND progress_epoch > 0
       AND ($now - progress_epoch) > $stale_secs;"
}

# ============================================================
# BLOCKERS
# ============================================================

db_add_blocker() {
  local desc="$1" task="${2:-}"
  local desc_esc; desc_esc=$(_sql_escape "$desc")
  local task_esc; task_esc=$(_sql_escape "$task")
  _sql_exec "INSERT INTO blockers (description, task_title, status) VALUES ('$desc_esc', '$task_esc', 'active');"
}

db_resolve_blocker() {
  local bid; bid=$(_sql_int "$1")
  _sql_exec "UPDATE blockers SET status='resolved', resolved_at=datetime('now') WHERE id=$bid;"
}

db_get_active_blockers() {
  _db_sep "SELECT id, description, task_title, created_at FROM blockers WHERE status='active' ORDER BY created_at ASC;"
}

db_count_active_blockers() {
  _db "SELECT COUNT(*) FROM blockers WHERE status='active';"
}

# ============================================================
# EVENTS
# ============================================================

db_add_event() {
  local event="$1" detail="${2:-}" wid="${3:-}" trace_id="${4:-}"
  local detail_esc; detail_esc=$(_sql_escape "$detail")
  local event_esc; event_esc=$(_sql_escape "$event")
  local trace_esc; trace_esc=$(_sql_escape "$trace_id")
  local epoch; epoch=$(date +%s)
  local wid_val="NULL"
  [ -n "$wid" ] && wid_val=$(_sql_int "$wid")
  _sql_exec "INSERT INTO events (epoch, event, detail, worker_id, trace_id) VALUES ($epoch, '$event_esc', '$detail_esc', $wid_val, '$trace_esc');"
}

db_get_recent_events() {
  local limit; limit=$(_sql_int "${1:-100}")
  _db_sep "SELECT epoch, event, detail, worker_id FROM events ORDER BY epoch DESC LIMIT $limit;"
}

# ============================================================
# FIXER STATS
# ============================================================

db_add_fixer_stat() {
  local result="$1" title="$2" fixer_id="${3:-}"
  local result_esc; result_esc=$(_sql_escape "$result")
  local title_esc; title_esc=$(_sql_escape "$title")
  local epoch; epoch=$(date +%s)
  local fid_val="NULL"
  [ -n "$fixer_id" ] && fid_val=$(_sql_int "$fixer_id")
  _sql_exec "INSERT INTO fixer_stats (epoch, result, task_title, fixer_id) VALUES ($epoch, '$result_esc', '$title_esc', $fid_val);"
}

# Get last N fixer results (for consecutive failure detection)
db_get_consecutive_failures() {
  local count; count=$(_sql_int "${1:-5}")
  _db_sep "SELECT result FROM fixer_stats ORDER BY epoch DESC LIMIT $count;"
}

db_get_fix_rate_24h() {
  local cutoff; cutoff=$(( $(date +%s) - 86400 ))
  _db "
    SELECT CASE WHEN COUNT(*)=0 THEN 0
      ELSE CAST(ROUND(100.0*SUM(CASE WHEN result='success' THEN 1 ELSE 0 END)/COUNT(*)) AS INTEGER)
    END FROM fixer_stats WHERE epoch > $cutoff;
  "
}

# ============================================================
# HEALTH SCORE
# ============================================================

db_get_health_score() {
  local failed_pending active_blockers stale_hbs stale_tasks
  failed_pending=$(_db "SELECT COUNT(*) FROM tasks WHERE status='failed';")
  active_blockers=$(_db "SELECT COUNT(*) FROM blockers WHERE status='active';")
  local stale_secs=$(( ${SKYNET_STALE_MINUTES:-45} * 60 ))
  stale_hbs=$(db_get_stale_heartbeats "$stale_secs" "${SKYNET_MAX_WORKERS:-4}" | grep -c .) || stale_hbs=0
  stale_tasks=$(_db "SELECT COUNT(*) FROM workers WHERE status='in_progress' AND started_at IS NOT NULL AND (julianday('now')-julianday(started_at))>1;")
  local score=$((100 - failed_pending * 5 - active_blockers * 10 - stale_hbs * 2 - stale_tasks))
  [ "$score" -lt 0 ] && score=0
  [ "$score" -gt 100 ] && score=100
  echo "$score"
}

# ============================================================
# CONTEXT EXPORT (for project-driver LLM prompt)
# ============================================================

db_export_context() {
  # Single sqlite3 call with section headers embedded as literal SELECT values
  printf '.timeout 15000\n%s\n' "
    SELECT '## Backlog (pending tasks)';
    SELECT '- [ ] [' || tag || '] ' || title FROM tasks WHERE status='pending' ORDER BY priority ASC;
    SELECT '';
    SELECT '## Claimed tasks';
    SELECT '- [>] [' || tag || '] ' || title FROM tasks WHERE status='claimed' ORDER BY priority ASC;
    SELECT '';
    SELECT '## Recent completed (last 30)';
    SELECT completed_at, title, branch, duration, notes FROM tasks WHERE status IN ('completed','fixed') ORDER BY completed_at DESC LIMIT 30;
    SELECT '';
    SELECT '## Failed tasks (pending retry)';
    SELECT title, branch, error, attempts, status FROM tasks WHERE status IN ('failed','blocked') OR status LIKE 'fixing-%' ORDER BY failed_at DESC;
    SELECT '';
    SELECT '## Active blockers';
    SELECT '- ' || description FROM blockers WHERE status='active';
    SELECT '';
    SELECT '## Recent done (last 40)';
    SELECT '- [x] [' || tag || '] ' || title FROM tasks WHERE status='done' ORDER BY updated_at DESC LIMIT 40;
  " | sqlite3 -separator ' | ' "$DB_PATH" 2>/dev/null || true
}

# Mission-scoped context export (filters tasks by mission_hash).
db_export_context_for_mission() {
  local hash; hash=$(_sql_escape "$1")
  printf '.timeout 15000\n%s\n' "
    SELECT '## Backlog (pending tasks)';
    SELECT '- [ ] [' || tag || '] ' || title FROM tasks WHERE status='pending' AND mission_hash='$hash' ORDER BY priority ASC;
    SELECT '';
    SELECT '## Claimed tasks';
    SELECT '- [>] [' || tag || '] ' || title FROM tasks WHERE status='claimed' AND mission_hash='$hash' ORDER BY priority ASC;
    SELECT '';
    SELECT '## Recent completed (last 30)';
    SELECT completed_at, title, branch, duration, notes FROM tasks WHERE status IN ('completed','fixed') AND mission_hash='$hash' ORDER BY completed_at DESC LIMIT 30;
    SELECT '';
    SELECT '## Failed tasks (pending retry)';
    SELECT title, branch, error, attempts, status FROM tasks WHERE (status IN ('failed','blocked') OR status LIKE 'fixing-%') AND mission_hash='$hash' ORDER BY failed_at DESC;
    SELECT '';
    SELECT '## Active blockers';
    SELECT '- ' || description FROM blockers WHERE status='active' AND task_title IN (
      SELECT title FROM tasks WHERE mission_hash='$hash'
    );
    SELECT '';
    SELECT '## Recent done (last 40)';
    SELECT '- [x] [' || tag || '] ' || title FROM tasks WHERE status='done' AND mission_hash='$hash' ORDER BY updated_at DESC LIMIT 40;
  " | sqlite3 -separator ' | ' "$DB_PATH" 2>/dev/null || true
}

# Get branches for stale cleanup (fixed/superseded/blocked tasks)
db_get_cleanup_branches() {
  _db "SELECT DISTINCT branch FROM tasks WHERE status IN ('fixed','superseded','blocked') AND branch != '' AND branch NOT LIKE 'merged%';"
}

# Check if a task title already exists (for dedup)
# OPS-P2-8: Check both title and normalized_root for deduplication
db_task_exists() {
  local title; title=$(_sql_escape "$1")
  local count
  count=$(_sql_query "SELECT COUNT(*) FROM tasks WHERE title='$title';")
  [ "${count:-0}" != "0" ] && return 0

  # Also check against normalized_root for active tasks to catch semantic duplicates
  local norm_root
  norm_root=$(echo "$1" | sed 's/\[[A-Z]*\] *//g' | tr '[:upper:]' '[:lower:]' | sed 's/  */ /g;s/^ *//;s/ *$//' | cut -c1-120)
  if [ -n "$norm_root" ]; then
    local norm_esc; norm_esc=$(_sql_escape "$norm_root")
    local norm_count
    norm_count=$(_sql_query "SELECT COUNT(*) FROM tasks WHERE normalized_root='$norm_esc' AND (status IN ('pending','claimed') OR status LIKE 'fixing-%');")
    [ "${norm_count:-0}" != "0" ] && return 0
  fi

  return 1
}

# Get all tasks for export (pipe-delimited)
db_export_all_tasks() {
  _db_sep \
    "SELECT id, title, tag, description, status, blocked_by, branch, worker_id, error, attempts, duration, notes, priority, created_at, updated_at, claimed_at, completed_at, failed_at FROM tasks ORDER BY id;"
}

# ============================================================
# STATE FILE EXPORT (regenerate markdown from SQLite)
# ============================================================
#
# NOTE: File writes use atomic rename (write to .tmp, then mv) to prevent
# partial reads. Callers reading exported files may still see stale data
# during the window between two export cycles — this is acceptable for
# display purposes.

# Generate backlog.md from tasks table.
# Atomic write via tmp+mv to prevent partial reads.
db_export_backlog() {
  [ ! -f "$DB_PATH" ] && return 0
  local output="$1"
  local tmpfile="${output}.export-tmp"
  {
    echo "# Backlog"
    echo ""
    echo "<!-- Priority: top = highest. Format: - [ ] [TAG] Task title — description -->"
    echo "<!-- Markers: [ ] = pending, [>] = claimed by worker, [x] = done -->"
    echo ""
    # Pending + claimed tasks ordered by priority
    _db_sep \
      "SELECT tag, title, description, status, blocked_by FROM tasks
       WHERE status IN ('pending','claimed')
       ORDER BY priority ASC;" 2>/dev/null | while IFS="$_DB_SEP" read -r _tag _title _desc _status _blocked; do
      _marker=" "
      [ "$_status" = "claimed" ] && _marker=">"
      # Strip leading [TAG] from title if already present (legacy data)
      _title=$(echo "$_title" | sed "s/^\[${_tag}\] *//")
      _line="- [${_marker}] [${_tag}] ${_title}"
      [ -n "$_desc" ] && _line="${_line} — ${_desc}"
      [ -n "$_blocked" ] && _line="${_line} | blockedBy: ${_blocked}"
      echo "$_line"
    done
    # Recent done history
    local _done_count
    _done_count=$(_db "SELECT COUNT(*) FROM tasks WHERE status='done';" 2>/dev/null || echo 0)
    if [ "${_done_count:-0}" -gt 0 ]; then
      echo ""
      echo "# Recent checked history (last 30)"
      _db_sep \
        "SELECT tag, title, description, blocked_by, notes FROM tasks
         WHERE status='done'
         ORDER BY updated_at DESC LIMIT 30;" 2>/dev/null | while IFS="$_DB_SEP" read -r _tag _title _desc _blocked _notes; do
        # Strip leading [TAG] from title if already present (legacy data)
        _title=$(echo "$_title" | sed "s/^\[${_tag}\] *//")
        _line="- [x] [${_tag}] ${_title}"
        [ -n "$_desc" ] && _line="${_line} — ${_desc}"
        [ -n "$_notes" ] && [ "$_notes" != "success" ] && _line="${_line} _(${_notes})_"
        echo "$_line"
      done
    fi
  } > "$tmpfile"
  mv "$tmpfile" "$output"
}

# Generate completed.md from tasks table.
db_export_completed() {
  [ ! -f "$DB_PATH" ] && return 0
  local output="$1"
  local tmpfile="${output}.export-tmp"
  {
    echo "# Completed Tasks"
    echo ""
    echo "| Date | Task | Branch | Duration | Notes |"
    echo "|------|------|--------|----------|-------|"
    _db_sep \
      "SELECT COALESCE(MAX(completed_at),''), tag, title, COALESCE(MAX(branch),''), COALESCE(MAX(duration),''), COALESCE(MAX(notes),'')
       FROM tasks
       WHERE status IN ('completed','fixed')
       GROUP BY tag, title
       ORDER BY MAX(completed_at) DESC
       LIMIT 200;" 2>/dev/null | while IFS="$_DB_SEP" read -r _date _tag _title _branch _dur _notes; do
      _datestr="${_date%% *}"
      [ -z "$_datestr" ] && _datestr="$(date '+%Y-%m-%d')"
      # Strip leading [TAG] from title if already present (legacy data)
      _title=$(echo "$_title" | sed "s/^\[${_tag}\] *//")
      _task="[${_tag}] ${_title}"
      echo "| ${_datestr} | ${_task} | ${_branch:-merged to main} | ${_dur:-0m} | ${_notes:-success} |"
    done
  } > "$tmpfile"
  mv "$tmpfile" "$output"
}

# Generate failed-tasks.md from tasks table.
db_export_failed() {
  [ ! -f "$DB_PATH" ] && return 0
  local output="$1"
  local tmpfile="${output}.export-tmp"
  {
    echo "# Failed Tasks"
    echo ""
    echo "| Date | Task | Branch | Error | Attempts | Status |"
    echo "|------|------|--------|-------|----------|--------|"
    _db_sep \
      "SELECT COALESCE(failed_at,''), tag, title, COALESCE(branch,''), COALESCE(error,''), COALESCE(attempts,0), status
       FROM tasks
       WHERE status IN ('failed','blocked','fixed','superseded')
          OR status LIKE 'fixing-%'
       ORDER BY CASE
         WHEN status='failed' THEN 0
         WHEN status LIKE 'fixing-%' THEN 1
         WHEN status='blocked' THEN 2
         WHEN status='fixed' THEN 3
         WHEN status='superseded' THEN 4
         ELSE 5
       END, failed_at DESC;" 2>/dev/null | while IFS="$_DB_SEP" read -r _date _tag _title _branch _error _attempts _status; do
      _datestr="${_date%% *}"
      [ -z "$_datestr" ] && _datestr="$(date '+%Y-%m-%d')"
      # Strip leading [TAG] from title if already present (legacy data)
      _title=$(echo "$_title" | sed "s/^\[${_tag}\] *//")
      _task="[${_tag}] ${_title}"
      echo "| ${_datestr} | ${_task} | ${_branch} | ${_error} | ${_attempts:-0} | ${_status} |"
    done
  } > "$tmpfile"
  mv "$tmpfile" "$output"
}

# Regenerate all state markdown files from SQLite.
# Call inside merge lock before git commit of state files.
#
# NOTE: State file export is sequential (backlog.md, completed.md, etc.).
# Between exports, a concurrent git pull could read a mix of old and new files.
# This is acceptable because SQLite is the authoritative source of truth —
# state files are human-readable views only.
db_export_state_files() {
  [ ! -f "$DB_PATH" ] && return 0
  local _errs=0
  db_export_backlog "$BACKLOG" 2>/dev/null || { log "WARNING: db_export_backlog failed"; _errs=$((_errs+1)); }
  db_export_completed "$COMPLETED" 2>/dev/null || { log "WARNING: db_export_completed failed"; _errs=$((_errs+1)); }
  db_export_failed "$FAILED" 2>/dev/null || { log "WARNING: db_export_failed failed"; _errs=$((_errs+1)); }
  [ $_errs -gt 0 ] && return 1
  return 0
}

# ============================================================
# DIAGNOSTICS
# ============================================================

# Detect circular blocked_by dependencies (A blocks B, B blocks A).
# Returns rows of "task_id|path" for tasks involved in cycles, or empty if none.
# Uses a recursive CTE with depth limit to walk the dependency graph.
# origin_id tracks the starting task through the chain so we detect when the
# walk returns to its starting point.
db_detect_circular_deps() {
  _db "
    WITH RECURSIVE dep_chain(origin_id, cur_title, dep_title, path, depth) AS (
      SELECT id, title,
        TRIM(SUBSTR(blocked_by, 1, INSTR(blocked_by || ',', ',') - 1)),
        title, 1
      FROM tasks WHERE status = 'pending' AND blocked_by != ''
      UNION ALL
      SELECT dc.origin_id, t.title,
        TRIM(SUBSTR(t.blocked_by, 1, INSTR(t.blocked_by || ',', ',') - 1)),
        dc.path || ' -> ' || t.title, dc.depth + 1
      FROM dep_chain dc
      JOIN tasks t ON t.title = dc.dep_title AND t.status = 'pending' AND t.blocked_by != ''
      WHERE dc.depth < 10
    )
    SELECT DISTINCT origin_id, path || ' -> ' || dep_title FROM dep_chain
    WHERE dep_title = (SELECT title FROM tasks WHERE id = origin_id);
  "
}

# ============================================================
# MAINTENANCE
# ============================================================

# Prune fixer_stats older than N days (default 90). Returns silently on no-op.
db_prune_old_fixer_stats() {
  local days="${1:-90}"
  local cutoff_epoch=$(( $(date +%s) - days * 86400 ))
  local deleted
  deleted=$(_db "DELETE FROM fixer_stats WHERE epoch < $cutoff_epoch; SELECT changes();")
  [ "${deleted:-0}" -gt 0 ] && log "Pruned $deleted fixer_stats entries older than ${days} days" 2>/dev/null || true
}

# Prune events older than N days (default 7). Returns silently on no-op.
db_prune_old_events() {
  local days="${1:-7}"
  local cutoff_epoch=$(( $(date +%s) - days * 86400 ))
  local deleted
  deleted=$(_db "DELETE FROM events WHERE epoch < $cutoff_epoch; SELECT changes();")
  [ "${deleted:-0}" -gt 0 ] && log "Pruned $deleted events older than ${days} days" 2>/dev/null || true
}

# --- WAL Checkpoint Strategy ---
# SQLite WAL (Write-Ahead Logging) accumulates changes in a separate WAL file.
# Two checkpoint modes are used:
#
#   PASSIVE (db_wal_checkpoint) — called every watchdog cycle (~60s).
#     Non-blocking: transfers WAL pages to the DB file only if no readers hold
#     those pages. Does not wait for readers. Safe to call frequently. Prevents
#     WAL file from growing unbounded during normal operation.
#
#   TRUNCATE (db_maintenance) — called every 10 watchdog cycles (~10min).
#     Blocking: waits for all readers to finish, copies all WAL pages to the
#     DB file, then truncates the WAL file to zero length, reclaiming disk
#     space. More expensive but necessary to prevent WAL file from growing
#     monotonically even after PASSIVE checkpoints transfer all pages.
#
# Both modes are safe for concurrent readers in WAL mode. Only one writer can
# run at a time (enforced by SQLite's internal locking + busy_timeout).

# Lightweight WAL checkpoint — call every watchdog cycle to prevent WAL growth.
# Uses PASSIVE mode (non-blocking) unlike the TRUNCATE in db_maintenance().
db_wal_checkpoint() {
  _db_no_out "PRAGMA wal_checkpoint(PASSIVE);" 2>/dev/null || true
}

# P0-WAL: Circuit breaker — returns 0 (healthy) or 1 (degraded).
# Unhealthy when 3+ consecutive WAL checkpoint failures have occurred.
db_is_wal_healthy() {
  [ "$_db_wal_checkpoint_failures" -lt 3 ] 2>/dev/null
}

# P0-WAL: Status reporter — prints failure count and health string.
# Used by status surfaces for operator visibility.
db_wal_status() {
  local _status="healthy"
  if ! db_is_wal_healthy; then
    _status="degraded"
  fi
  printf '%s %s\n' "$_db_wal_checkpoint_failures" "$_status"
}

# Run integrity check, optimize, optional VACUUM, WAL checkpoint, and event pruning.
# Returns 0 on success, 1 if integrity check fails.
db_maintenance() {
  [ ! -f "$DB_PATH" ] && { log "ERROR: db_maintenance — database not found"; return 1; }

  # Step 1: WAL checkpoint — prevents unbounded WAL growth
  _db_no_out "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true

  # Step 2: integrity_check
  # OPS-P1-4: Wrap integrity_check with a 30-second timeout to prevent runaway
  # checks on large databases from blocking the maintenance cycle indefinitely.
  local integrity
  local _ic_timeout=${SKYNET_INTEGRITY_CHECK_TIMEOUT:-30}
  integrity=$(run_with_timeout "$_ic_timeout" sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>/dev/null)
  local _ic_rc=$?
  if [ "$_ic_rc" -eq 124 ] 2>/dev/null || [ "$_ic_rc" -eq 142 ] 2>/dev/null; then
    log "WARNING: db_maintenance — integrity_check timed out after ${_ic_timeout}s"
    return 1
  fi
  if [ "$integrity" != "ok" ]; then
    log "ERROR: db_maintenance — integrity_check failed: $integrity"
    return 1
  fi

  # Step 3: PRAGMA optimize (auto-analyze)
  _db_no_out "PRAGMA optimize;" 2>/dev/null || true

  # Step 4: VACUUM only if DB file > 10MB
  local db_size
  db_size=$(file_size "$DB_PATH")
  local threshold=10485760  # 10MB
  if [ "${db_size:-0}" -gt "$threshold" ] 2>/dev/null; then
    log "db_maintenance: DB size ${db_size} > 10MB — running VACUUM"
    _db_no_out "VACUUM;" 2>/dev/null || log "WARNING: VACUUM failed"
  fi

  # Step 5: Check for circular blocked_by dependencies
  local circular
  circular=$(db_detect_circular_deps 2>/dev/null) || true
  if [ -n "$circular" ]; then
    log "WARNING: Circular blocked_by dependencies detected — these tasks will never be claimed:"
    echo "$circular" | while IFS= read -r _line; do
      log "  circular dep: $_line"
    done
  fi

  # Step 6: Prune old events
  db_prune_old_events 7

  return 0
}

# Quick integrity check only — used by doctor command.
# Returns 0 if "ok", 1 otherwise.
db_check_integrity() {
  [ ! -f "$DB_PATH" ] && return 1
  # OPS-P1-4: Wrap integrity_check with a 30-second timeout
  local integrity
  local _ic_timeout=${SKYNET_INTEGRITY_CHECK_TIMEOUT:-30}
  integrity=$(run_with_timeout "$_ic_timeout" sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>/dev/null)
  local _ic_rc=$?
  # SH-P1-1: Handle both GNU timeout (124) and macOS perl SIGALRM (142) exit codes
  if [ "$_ic_rc" -eq 124 ] 2>/dev/null || [ "$_ic_rc" -eq 142 ] 2>/dev/null; then
    return 1
  fi
  [ "$integrity" = "ok" ] && return 0 || return 1
}
