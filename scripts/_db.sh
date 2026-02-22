#!/usr/bin/env bash
# _db.sh — SQLite database abstraction layer for Skynet pipeline
# Sourced by _config.sh. All functions wrap sqlite3 CLI calls.
# WAL mode handles concurrent reads + single writer — no more mkdir locks.

DB_PATH="${SKYNET_DEV_DIR}/skynet.db"

# --- SQL injection prevention ---
_sql_escape() { echo "$1" | sed "s/'/''/g"; }

# --- Error-checked sqlite3 wrapper for mutations ---
# Usage: _sql_exec "SQL statement"
# Logs to stderr and returns 1 on failure.
_sql_exec() {
  local _sql_err
  _sql_err=$(sqlite3 "$DB_PATH" "$1" 2>&1)
  local _sql_rc=$?
  if [ $_sql_rc -ne 0 ]; then
    log "ERROR: sqlite3 failed (rc=$_sql_rc): $_sql_err" 2>/dev/null || echo "ERROR: sqlite3 failed (rc=$_sql_rc): $_sql_err" >&2
    return 1
  fi
  echo "$_sql_err"
  return 0
}

# Error-checked sqlite3 wrapper that returns pipe-delimited rows.
_sql_query() {
  local _sql_err
  _sql_err=$(sqlite3 -separator '|' "$DB_PATH" "$1" 2>&1)
  local _sql_rc=$?
  if [ $_sql_rc -ne 0 ]; then
    log "ERROR: sqlite3 query failed (rc=$_sql_rc): $_sql_err" 2>/dev/null || echo "ERROR: sqlite3 query failed (rc=$_sql_rc): $_sql_err" >&2
    return 1
  fi
  echo "$_sql_err"
  return 0
}

# ============================================================
# INITIALIZATION
# ============================================================

db_init() {
  [ -f "$DB_PATH" ] || true  # sqlite3 creates if missing
  sqlite3 "$DB_PATH" <<'SCHEMA'
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

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
CREATE INDEX IF NOT EXISTS idx_tasks_normalized_root ON tasks(normalized_root);
CREATE INDEX IF NOT EXISTS idx_tasks_branch ON tasks(branch);

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

CREATE INDEX IF NOT EXISTS idx_events_epoch ON events(epoch);

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
}

# ============================================================
# TASK CRUD
# ============================================================

# Output: pipe-delimited rows: id|title|tag|description|blocked_by|priority
db_get_pending_tasks() {
  sqlite3 -separator '|' "$DB_PATH" \
    "SELECT id, title, tag, description, blocked_by, priority FROM tasks WHERE status = 'pending' ORDER BY priority ASC;"
}

db_count_pending() {
  sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status = 'pending';"
}

db_count_claimed() {
  sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status = 'claimed';"
}

db_count_by_status() {
  local status; status=$(_sql_escape "$1")
  sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status = '$status';"
}

# Find + atomically claim the next unblocked pending task for a worker.
# Output: id|title|tag|description|branch  or empty string if none available.
db_claim_next_task() {
  local worker_id="$1"
  local result=""
  while IFS='|' read -r tid ttitle tblocked; do
    [ -z "$tid" ] && continue
    local blocked=false
    if [ -n "$tblocked" ]; then
      local _old_ifs="$IFS"; IFS=','
      for dep in $tblocked; do
        IFS="$_old_ifs"
        dep=$(echo "$dep" | sed 's/^ *//;s/ *$//')
        [ -z "$dep" ] && continue
        local dep_esc; dep_esc=$(_sql_escape "$dep")
        local dep_done
        dep_done=$(sqlite3 "$DB_PATH" \
          "SELECT COUNT(*) FROM tasks WHERE title='$dep_esc' AND status IN ('completed','done','fixed','superseded');")
        if [ "$dep_done" = "0" ]; then
          blocked=true; break
        fi
      done
      IFS="$_old_ifs"
    fi
    if ! $blocked; then
      local changed
      changed=$(sqlite3 "$DB_PATH" "
        UPDATE tasks SET status='claimed', worker_id=$worker_id,
          claimed_at=datetime('now'), updated_at=datetime('now')
        WHERE id=$tid AND status='pending';
        SELECT changes();
      ")
      if [ "$changed" = "1" ]; then
        result=$(sqlite3 -separator '|' "$DB_PATH" \
          "SELECT id, title, tag, description, branch FROM tasks WHERE id=$tid;")
        break
      fi
    fi
  done < <(sqlite3 -separator '|' "$DB_PATH" \
    "SELECT id, title, blocked_by FROM tasks WHERE status='pending' ORDER BY priority ASC;")
  echo "$result"
}

db_unclaim_task() {
  local task_id="$1"
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

# Complete a task (successful merge)
db_complete_task() {
  local task_id="$1" branch="$2" duration="$3" duration_secs="${4:-0}" notes="${5:-success}"
  local branch_esc; branch_esc=$(_sql_escape "$branch")
  local notes_esc; notes_esc=$(_sql_escape "$notes")
  _sql_exec "
    UPDATE tasks SET status='completed', branch='$branch_esc',
      duration='$duration', duration_secs=$duration_secs, notes='$notes_esc',
      completed_at=datetime('now'), updated_at=datetime('now')
    WHERE id=$task_id;
  "
}

# Record task failure
db_fail_task() {
  local task_id="$1" branch="$2" error="$3"
  local branch_esc; branch_esc=$(_sql_escape "$branch")
  local error_esc; error_esc=$(_sql_escape "$error")
  _sql_exec "
    UPDATE tasks SET status='failed', branch='$branch_esc', error='$error_esc',
      failed_at=datetime('now'), updated_at=datetime('now')
    WHERE id=$task_id;
  "
}

# Add a new task. Echoes the new task ID.
db_add_task() {
  local title="$1" tag="${2:-FEAT}" desc="${3:-}" position="${4:-top}" blocked_by="${5:-}"
  local title_esc; title_esc=$(_sql_escape "$title")
  local tag_esc; tag_esc=$(_sql_escape "$tag")
  local desc_esc; desc_esc=$(_sql_escape "$desc")
  local blocked_esc; blocked_esc=$(_sql_escape "$blocked_by")
  local norm_root
  norm_root=$(echo "$title" | sed 's/\[[A-Z]*\] *//g' | tr '[:upper:]' '[:lower:]' | sed 's/  */ /g;s/^ *//;s/ *$//' | cut -c1-120)

  if [ "$position" = "top" ]; then
    sqlite3 "$DB_PATH" "UPDATE tasks SET priority=priority+1 WHERE status IN ('pending','claimed');"
    sqlite3 "$DB_PATH" "
      INSERT INTO tasks (title, tag, description, status, blocked_by, normalized_root, priority)
      VALUES ('$title_esc', '$tag_esc', '$desc_esc', 'pending', '$blocked_esc', '$(_sql_escape "$norm_root")', 0);
      SELECT last_insert_rowid();
    "
  else
    local max_pri
    max_pri=$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(priority),0)+1 FROM tasks WHERE status IN ('pending','claimed');")
    sqlite3 "$DB_PATH" "
      INSERT INTO tasks (title, tag, description, status, blocked_by, normalized_root, priority)
      VALUES ('$title_esc', '$tag_esc', '$desc_esc', 'pending', '$blocked_esc', '$(_sql_escape "$norm_root")', $max_pri);
      SELECT last_insert_rowid();
    "
  fi
}

# Mark a backlog task as done (the [x] equivalent — task was completed elsewhere)
db_mark_done() {
  local task_id="$1"
  sqlite3 "$DB_PATH" "UPDATE tasks SET status='done', updated_at=datetime('now') WHERE id=$task_id;"
}

# Get task ID by title (exact match). Returns id or empty.
db_get_task_id_by_title() {
  local title; title=$(_sql_escape "$1")
  sqlite3 "$DB_PATH" "SELECT id FROM tasks WHERE title='$title' ORDER BY id DESC LIMIT 1;"
}

# Get task row by ID. Output: id|title|tag|status|branch|error|attempts
db_get_task() {
  local task_id="$1"
  sqlite3 -separator '|' "$DB_PATH" \
    "SELECT id, title, tag, status, branch, error, attempts FROM tasks WHERE id=$task_id;"
}

# ============================================================
# FAILURE MANAGEMENT
# ============================================================

# Output: id|title|branch|error|attempts|status (oldest first)
db_get_pending_failures() {
  sqlite3 -separator '|' "$DB_PATH" \
    "SELECT id, title, branch, error, attempts, status FROM tasks WHERE status='failed' ORDER BY failed_at ASC;"
}

db_claim_failure() {
  local task_id="$1" fixer_id="$2"
  local fixer_esc; fixer_esc=$(_sql_escape "$fixer_id")
  local changed
  changed=$(sqlite3 "$DB_PATH" "
    UPDATE tasks SET status='fixing-$fixer_esc', fixer_id=$fixer_id, updated_at=datetime('now')
    WHERE id=$task_id AND status='failed';
    SELECT changes();
  ")
  [ "$changed" = "1" ] && return 0 || return 1
}

db_unclaim_failure() {
  local fixer_id="$1"
  local fixer_esc; fixer_esc=$(_sql_escape "$fixer_id")
  sqlite3 "$DB_PATH" "
    UPDATE tasks SET status='failed', fixer_id=NULL, updated_at=datetime('now')
    WHERE status='fixing-$fixer_esc';
  "
}

db_update_failure() {
  local task_id="$1" error="$2" attempts="$3" status="$4"
  local error_esc; error_esc=$(_sql_escape "$error")
  local status_esc; status_esc=$(_sql_escape "$status")
  _sql_exec "
    UPDATE tasks SET error='$error_esc', attempts=$attempts, status='$status_esc', updated_at=datetime('now')
    WHERE id=$task_id;
  "
}

db_fix_task() {
  local task_id="$1" branch="$2" attempts="$3" error="${4:-}"
  local branch_esc; branch_esc=$(_sql_escape "$branch")
  local error_esc; error_esc=$(_sql_escape "$error")
  _sql_exec "
    UPDATE tasks SET status='fixed', branch='$branch_esc', attempts=$attempts, error='$error_esc',
      completed_at=datetime('now'), updated_at=datetime('now')
    WHERE id=$task_id;
  "
}

db_block_task() {
  local task_id="$1"
  _sql_exec "UPDATE tasks SET status='blocked', updated_at=datetime('now') WHERE id=$task_id;"
}

db_supersede_task() {
  local task_id="$1"
  _sql_exec "UPDATE tasks SET status='superseded', updated_at=datetime('now') WHERE id=$task_id;"
}

# Auto-supersede failed tasks matching completed roots. Returns count of changes.
db_auto_supersede_completed() {
  sqlite3 "$DB_PATH" "
    UPDATE tasks SET status='superseded', updated_at=datetime('now')
    WHERE status='failed' AND normalized_root != '' AND normalized_root IN (
      SELECT normalized_root FROM tasks WHERE status IN ('completed','fixed') AND normalized_root != ''
    );
    SELECT changes();
  "
}

# ============================================================
# WORKER STATUS
# ============================================================

db_set_worker_status() {
  local wid="$1" wtype="$2" status="$3" task_id="${4:-}" title="${5:-}" branch="${6:-}"
  local wtype_esc; wtype_esc=$(_sql_escape "$wtype")
  local status_esc; status_esc=$(_sql_escape "$status")
  local title_esc; title_esc=$(_sql_escape "$title")
  local branch_esc; branch_esc=$(_sql_escape "$branch")
  local started_val="NULL"
  [ "$status" = "in_progress" ] && started_val="datetime('now')"
  _sql_exec "
    INSERT INTO workers (id, worker_type, status, current_task_id, task_title, branch, started_at, updated_at)
    VALUES ($wid, '$wtype_esc', '$status_esc', ${task_id:-NULL}, '$title_esc', '$branch_esc', $started_val, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      worker_type='$wtype_esc', status='$status_esc', current_task_id=${task_id:-NULL},
      task_title='$title_esc', branch='$branch_esc',
      started_at=$started_val, updated_at=datetime('now');
  "
}

db_set_worker_idle() {
  local wid="$1" info="${2:-}"
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
  local wid="$1"
  local epoch; epoch=$(date +%s)
  _sql_exec "
    INSERT INTO workers (id, heartbeat_epoch, updated_at)
    VALUES ($wid, $epoch, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET heartbeat_epoch=$epoch, updated_at=datetime('now');
  "
}

# Output: id|worker_type|status|current_task_id|task_title|branch|started_at|heartbeat_epoch|last_info
db_get_worker_status() {
  local wid="$1"
  sqlite3 -separator '|' "$DB_PATH" \
    "SELECT id, worker_type, status, current_task_id, task_title, branch, started_at, heartbeat_epoch, last_info
     FROM workers WHERE id=$wid;"
}

# Output: id|heartbeat_epoch|age_secs (one per stale worker)
db_get_stale_heartbeats() {
  local stale_secs="$1"
  local now; now=$(date +%s)
  sqlite3 -separator '|' "$DB_PATH" \
    "SELECT id, heartbeat_epoch, ($now - heartbeat_epoch) as age_secs
     FROM workers
     WHERE heartbeat_epoch IS NOT NULL AND heartbeat_epoch > 0
       AND ($now - heartbeat_epoch) > $stale_secs;"
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
  local bid="$1"
  _sql_exec "UPDATE blockers SET status='resolved', resolved_at=datetime('now') WHERE id=$bid;"
}

db_get_active_blockers() {
  sqlite3 -separator '|' "$DB_PATH" "SELECT id, description, task_title, created_at FROM blockers WHERE status='active' ORDER BY created_at ASC;"
}

db_count_active_blockers() {
  sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM blockers WHERE status='active';"
}

# ============================================================
# EVENTS
# ============================================================

db_add_event() {
  local event="$1" detail="${2:-}" wid="${3:-}"
  local detail_esc; detail_esc=$(_sql_escape "$detail")
  local event_esc; event_esc=$(_sql_escape "$event")
  local epoch; epoch=$(date +%s)
  _sql_exec "INSERT INTO events (epoch, event, detail, worker_id) VALUES ($epoch, '$event_esc', '$detail_esc', ${wid:-NULL});"
}

db_get_recent_events() {
  local limit="${1:-100}"
  sqlite3 -separator '|' "$DB_PATH" "SELECT epoch, event, detail, worker_id FROM events ORDER BY epoch DESC LIMIT $limit;"
}

# ============================================================
# FIXER STATS
# ============================================================

db_add_fixer_stat() {
  local result="$1" title="$2" fixer_id="${3:-}"
  local result_esc; result_esc=$(_sql_escape "$result")
  local title_esc; title_esc=$(_sql_escape "$title")
  local epoch; epoch=$(date +%s)
  _sql_exec "INSERT INTO fixer_stats (epoch, result, task_title, fixer_id) VALUES ($epoch, '$result_esc', '$title_esc', ${fixer_id:-NULL});"
}

# Get last N fixer results (for consecutive failure detection)
db_get_consecutive_failures() {
  local count="${1:-5}"
  sqlite3 -separator '|' "$DB_PATH" "SELECT result FROM fixer_stats ORDER BY epoch DESC LIMIT $count;"
}

db_get_fix_rate_24h() {
  local cutoff; cutoff=$(( $(date +%s) - 86400 ))
  sqlite3 "$DB_PATH" "
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
  failed_pending=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='failed';")
  active_blockers=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM blockers WHERE status='active';")
  local stale_secs=$(( ${SKYNET_STALE_MINUTES:-45} * 60 ))
  stale_hbs=$(db_get_stale_heartbeats "$stale_secs" | grep -c '|') || stale_hbs=0
  stale_tasks=$(sqlite3 "$DB_PATH" \
    "SELECT COUNT(*) FROM workers WHERE status='in_progress' AND started_at IS NOT NULL AND (julianday('now')-julianday(started_at))>1;")
  local score=$((100 - failed_pending * 5 - active_blockers * 10 - stale_hbs * 2 - stale_tasks))
  [ "$score" -lt 0 ] && score=0
  [ "$score" -gt 100 ] && score=100
  echo "$score"
}

# ============================================================
# CONTEXT EXPORT (for project-driver LLM prompt)
# ============================================================

db_export_context() {
  echo "## Backlog (pending tasks)"
  sqlite3 "$DB_PATH" "SELECT '- [ ] [' || tag || '] ' || title FROM tasks WHERE status='pending' ORDER BY priority ASC;" 2>/dev/null || true
  echo ""
  echo "## Claimed tasks"
  sqlite3 "$DB_PATH" "SELECT '- [>] [' || tag || '] ' || title FROM tasks WHERE status='claimed' ORDER BY priority ASC;" 2>/dev/null || true
  echo ""
  echo "## Recent completed (last 30)"
  sqlite3 -separator ' | ' "$DB_PATH" \
    "SELECT completed_at, title, branch, duration, notes FROM tasks WHERE status IN ('completed','fixed') ORDER BY completed_at DESC LIMIT 30;" 2>/dev/null || true
  echo ""
  echo "## Failed tasks (pending retry)"
  sqlite3 -separator ' | ' "$DB_PATH" \
    "SELECT title, branch, error, attempts, status FROM tasks WHERE status IN ('failed','blocked') OR status LIKE 'fixing-%' ORDER BY failed_at DESC;" 2>/dev/null || true
  echo ""
  echo "## Active blockers"
  sqlite3 "$DB_PATH" "SELECT '- ' || description FROM blockers WHERE status='active';" 2>/dev/null || true
  echo ""
  echo "## Recent done (last 40)"
  sqlite3 "$DB_PATH" "SELECT '- [x] [' || tag || '] ' || title FROM tasks WHERE status='done' ORDER BY updated_at DESC LIMIT 40;" 2>/dev/null || true
}

# Get branches for stale cleanup (fixed/superseded/blocked tasks)
db_get_cleanup_branches() {
  sqlite3 "$DB_PATH" "SELECT DISTINCT branch FROM tasks WHERE status IN ('fixed','superseded','blocked') AND branch != '' AND branch NOT LIKE 'merged%';"
}

# Check if a task title already exists (for dedup)
db_task_exists() {
  local title; title=$(_sql_escape "$1")
  local count
  count=$(_sql_query "SELECT COUNT(*) FROM tasks WHERE title='$title';")
  [ "${count:-0}" != "0" ] && return 0 || return 1
}

# Get all tasks for export (pipe-delimited)
db_export_all_tasks() {
  sqlite3 -separator '|' "$DB_PATH" \
    "SELECT id, title, tag, description, status, blocked_by, branch, worker_id, error, attempts, duration, notes, priority, created_at, updated_at, claimed_at, completed_at, failed_at FROM tasks ORDER BY id;"
}
