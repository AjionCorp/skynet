#!/usr/bin/env bash
# migrate-to-sqlite.sh — One-time migration from markdown state files to SQLite
# Usage: bash scripts/migrate-to-sqlite.sh
# Backs up originals to .dev/md-backup/ and populates .dev/skynet.db

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/.dev"
DB_PATH="$DEV_DIR/skynet.db"
BACKUP_DIR="$DEV_DIR/md-backup"

# Set SKYNET_DEV_DIR before sourcing _db.sh (it uses it for DB_PATH)
export SKYNET_DEV_DIR="$DEV_DIR"
source "$SCRIPT_DIR/_db.sh"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ── Pre-flight checks ────────────────────────────────────────────────

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 is required but not found in PATH" >&2
  exit 1
fi

if [ -f "$DB_PATH" ]; then
  existing_tasks=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks;" 2>/dev/null || echo "0")
  if [ "$existing_tasks" != "0" ]; then
    # Check for partial migration — allow resuming incomplete runs
    _completed_sections=$(sqlite3 "$DB_PATH" "SELECT value FROM _metadata WHERE key='migration_sections';" 2>/dev/null || echo "")
    if [ -n "$_completed_sections" ] && echo "$_completed_sections" | grep -qv "ALL"; then
      log "Detected partial migration (completed: $_completed_sections). Resuming..."
    else
      echo "WARNING: $DB_PATH already contains $existing_tasks tasks."
      echo "If you want to re-migrate, remove $DB_PATH first: rm $DB_PATH"
      exit 1
    fi
  fi
fi

# Helper: check if a migration section was already completed
_section_done() { echo "${_completed_sections:-}" | grep -q "$1"; }
# Helper: mark a migration section as completed
_mark_section() {
  local _cur; _cur=$(sqlite3 "$DB_PATH" "SELECT value FROM _metadata WHERE key='migration_sections';" 2>/dev/null || echo "")
  if [ -z "$_cur" ]; then
    sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO _metadata (key, value) VALUES ('migration_sections', '$1');"
  else
    sqlite3 "$DB_PATH" "UPDATE _metadata SET value='${_cur},$1' WHERE key='migration_sections';"
  fi
}

log "Starting migration to SQLite..."
log "  DB: $DB_PATH"
log "  Backup: $BACKUP_DIR"

# ── Initialize database ──────────────────────────────────────────────

DB_PATH="$DEV_DIR/skynet.db"
db_init
log "Database initialized with schema v1"

# ── Backup originals ─────────────────────────────────────────────────

mkdir -p "$BACKUP_DIR"
for f in backlog.md completed.md failed-tasks.md blockers.md events.log fixer-stats.log; do
  if [ -f "$DEV_DIR/$f" ]; then
    cp "$DEV_DIR/$f" "$BACKUP_DIR/$f"
  fi
done
for f in "$DEV_DIR"/current-task-*.md; do
  [ -f "$f" ] && cp "$f" "$BACKUP_DIR/$(basename "$f")"
done
for f in "$DEV_DIR"/worker-*.heartbeat; do
  [ -f "$f" ] && cp "$f" "$BACKUP_DIR/$(basename "$f")"
done
log "Backed up originals to $BACKUP_DIR"

# ── Helper: SQL-safe string ──────────────────────────────────────────

esc() { echo "$1" | sed "s/'/''/g"; }

# ── Migrate backlog.md ────────────────────────────────────────────────

backlog_count=0
if _section_done "backlog"; then
  log "  Backlog: already migrated — skipping"
  backlog_count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE priority < 99999;" 2>/dev/null || echo 0)
elif [ -f "$DEV_DIR/backlog.md" ]; then
  log "Migrating backlog.md..."
  priority=0
  while IFS= read -r line; do
    # Parse status marker
    status=""
    text=""
    if echo "$line" | grep -q '^- \[ \] '; then
      status="pending"
      text=$(echo "$line" | sed 's/^- \[ \] //')
    elif echo "$line" | grep -q '^- \[>\] '; then
      status="claimed"
      text=$(echo "$line" | sed 's/^- \[>\] //')
    elif echo "$line" | grep -q '^- \[x\] '; then
      status="done"
      text=$(echo "$line" | sed 's/^- \[x\] //')
    else
      continue
    fi

    # Extract tag
    tag=""
    if echo "$text" | grep -q '^\[[A-Z]*\]'; then
      tag=$(echo "$text" | sed 's/^\[\([A-Z]*\)\].*/\1/')
      text=$(echo "$text" | sed 's/^\[[A-Z]*\] *//')
    fi

    # Extract blockedBy
    blocked_by=""
    if echo "$text" | grep -qi '| *blockedBy:'; then
      blocked_by=$(echo "$text" | sed 's/.*| *[bB]locked[bB]y: *//;s/ *$//')
      text=$(echo "$text" | sed 's/ *| *[bB]locked[bB]y:.*//')
    fi

    # Split title and description at em-dash
    title="$text"
    description=""
    if echo "$text" | grep -q ' — '; then
      title=$(echo "$text" | sed 's/ — .*//')
      description=$(echo "$text" | sed 's/^[^—]*— //')
    fi

    # Strip trailing notes like _(worktree missing)_ _(claude failed)_ etc
    title=$(echo "$title" | sed 's/ *_([^)]*)_ *$//')

    # Normalized root
    norm_root=$(echo "$title" | tr '[:upper:]' '[:lower:]' | sed 's/  */ /g;s/^ *//;s/ *$//' | cut -c1-50)

    title_esc=$(esc "$title")
    desc_esc=$(esc "$description")
    blocked_esc=$(esc "$blocked_by")
    norm_esc=$(esc "$norm_root")

    sqlite3 "$DB_PATH" "
      INSERT INTO tasks (title, tag, description, status, blocked_by, priority, normalized_root)
      VALUES ('$title_esc', '$tag', '$desc_esc', '$status', '$blocked_esc', $priority, '$norm_esc');
    "
    priority=$((priority + 1))
    backlog_count=$((backlog_count + 1))
  done < "$DEV_DIR/backlog.md"
  log "  Backlog: $backlog_count items migrated"
  _mark_section "backlog"
fi

# ── Migrate completed.md ─────────────────────────────────────────────

completed_count=0
if _section_done "completed"; then
  log "  Completed: already migrated — skipping"
  completed_count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='completed';" 2>/dev/null || echo 0)
elif [ -f "$DEV_DIR/completed.md" ]; then
  log "Migrating completed.md..."
  while IFS= read -r line; do
    # Skip header, separator, empty lines
    echo "$line" | grep -q '^|' || continue
    echo "$line" | grep -q 'Date' && continue
    echo "$line" | grep -q '^|[-| ]*$' && continue

    # Parse pipe-delimited columns: | Date | Task | Branch | [Duration] | Notes |
    # Strip leading/trailing pipes and whitespace
    parts=$(echo "$line" | sed 's/^ *| *//;s/ *| *$//')

    date_val=$(echo "$parts" | awk -F' *\\| *' '{print $1}')
    task_val=$(echo "$parts" | awk -F' *\\| *' '{print $2}')
    branch_val=$(echo "$parts" | awk -F' *\\| *' '{print $3}')

    # Count fields to determine if Duration column exists
    field_count=$(echo "$parts" | awk -F' *\\| *' '{print NF}')
    if [ "$field_count" -ge 4 ]; then
      # Could be old format (Date|Task|Branch|Notes) or new (Date|Task|Branch|Duration|Notes)
      col4=$(echo "$parts" | awk -F' *\\| *' '{print $4}')
      # If col4 looks like a duration (Nm, Nh, Nh Nm) it's the new format
      if echo "$col4" | grep -qE '^[0-9]+[hm]'; then
        duration_val="$col4"
        notes_val=$(echo "$parts" | awk -F' *\\| *' '{print $5}')
      else
        duration_val=""
        notes_val="$col4"
      fi
    else
      duration_val=""
      notes_val=""
    fi

    # Parse duration to seconds
    duration_secs="NULL"
    if [ -n "$duration_val" ]; then
      hours=0; mins=0
      if echo "$duration_val" | grep -qE '^[0-9]+h [0-9]+m$'; then
        hours=$(echo "$duration_val" | sed 's/h.*//')
        mins=$(echo "$duration_val" | sed 's/.*h //;s/m//')
      elif echo "$duration_val" | grep -qE '^[0-9]+h$'; then
        hours=$(echo "$duration_val" | sed 's/h//')
      elif echo "$duration_val" | grep -qE '^[0-9]+m$'; then
        mins=$(echo "$duration_val" | sed 's/m//')
      fi
      duration_secs=$(( hours * 3600 + mins * 60 ))
    fi

    # Extract tag from task
    tag=""
    title="$task_val"
    if echo "$task_val" | grep -q '^\[[A-Z]*\]'; then
      tag=$(echo "$task_val" | sed 's/^\[\([A-Z]*\)\].*/\1/')
      title=$(echo "$task_val" | sed 's/^\[[A-Z]*\] *//')
    fi

    # Split title/description
    description=""
    if echo "$title" | grep -q ' — '; then
      description=$(echo "$title" | sed 's/^[^—]*— //')
      title=$(echo "$title" | sed 's/ — .*//')
    fi

    norm_root=$(echo "$title" | tr '[:upper:]' '[:lower:]' | sed 's/  */ /g;s/^ *//;s/ *$//' | cut -c1-50)

    sqlite3 "$DB_PATH" "
      INSERT INTO tasks (title, tag, description, status, branch, duration, duration_secs, notes,
        completed_at, normalized_root, priority)
      VALUES ('$(esc "$title")', '$tag', '$(esc "$description")', 'completed',
        '$(esc "$branch_val")', '$(esc "$duration_val")', $duration_secs, '$(esc "$notes_val")',
        '$(esc "$date_val")', '$(esc "$norm_root")', 99999);
    "
    completed_count=$((completed_count + 1))
  done < "$DEV_DIR/completed.md"
  log "  Completed: $completed_count tasks migrated"
  _mark_section "completed"
fi

# ── Migrate failed-tasks.md ──────────────────────────────────────────

failed_count=0
if _section_done "failed"; then
  log "  Failed: already migrated — skipping"
  failed_count=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status IN ('failed','blocked','superseded') OR status LIKE 'fixing-%';" 2>/dev/null || echo 0)
elif [ -f "$DEV_DIR/failed-tasks.md" ]; then
  log "Migrating failed-tasks.md..."
  while IFS= read -r line; do
    echo "$line" | grep -q '^|' || continue
    echo "$line" | grep -q 'Date' && continue
    echo "$line" | grep -q '^|[-| ]*$' && continue

    # | Date | Task | Branch | Error | Attempts | Status |
    parts=$(echo "$line" | sed 's/^ *| *//;s/ *| *$//')

    date_val=$(echo "$parts" | awk -F' *\\| *' '{print $1}')
    task_val=$(echo "$parts" | awk -F' *\\| *' '{print $2}')
    branch_val=$(echo "$parts" | awk -F' *\\| *' '{print $3}')
    error_val=$(echo "$parts" | awk -F' *\\| *' '{print $4}')
    attempts_val=$(echo "$parts" | awk -F' *\\| *' '{print $5}')
    status_val=$(echo "$parts" | awk -F' *\\| *' '{print $6}')

    # Default attempts to 0 if empty/non-numeric
    if ! echo "$attempts_val" | grep -qE '^[0-9]+$'; then
      attempts_val=0
    fi

    # Default status to failed if empty
    [ -z "$status_val" ] && status_val="failed"

    # Extract tag from task
    tag=""
    title="$task_val"
    if echo "$task_val" | grep -q '^\[[A-Z]*\]'; then
      tag=$(echo "$task_val" | sed 's/^\[\([A-Z]*\)\].*/\1/')
      title=$(echo "$task_val" | sed 's/^\[[A-Z]*\] *//')
    fi

    # Split title/description
    description=""
    if echo "$title" | grep -q ' — '; then
      description=$(echo "$title" | sed 's/^[^—]*— //')
      title=$(echo "$title" | sed 's/ — .*//')
    fi

    norm_root=$(echo "$title" | tr '[:upper:]' '[:lower:]' | sed 's/  */ /g;s/^ *//;s/ *$//' | cut -c1-50)

    sqlite3 "$DB_PATH" "
      INSERT INTO tasks (title, tag, description, status, branch, error, attempts,
        failed_at, normalized_root, priority)
      VALUES ('$(esc "$title")', '$tag', '$(esc "$description")', '$(esc "$status_val")',
        '$(esc "$branch_val")', '$(esc "$error_val")', $attempts_val,
        '$(esc "$date_val")', '$(esc "$norm_root")', 99999);
    "
    failed_count=$((failed_count + 1))
  done < "$DEV_DIR/failed-tasks.md"
  log "  Failed: $failed_count tasks migrated"
  _mark_section "failed"
fi

# ── Migrate blockers.md ──────────────────────────────────────────────

blocker_count=0
if _section_done "blockers"; then
  log "  Blockers: already migrated — skipping"
elif [ -f "$DEV_DIR/blockers.md" ]; then
  log "Migrating blockers.md..."
  current_section=""
  while IFS= read -r line; do
    # Track sections
    if echo "$line" | grep -q '^## Active'; then
      current_section="active"
      continue
    elif echo "$line" | grep -q '^## Resolved'; then
      current_section="resolved"
      continue
    elif echo "$line" | grep -q '^## '; then
      current_section=""
      continue
    fi

    # Only migrate active blockers (resolved are historical)
    if [ "$current_section" = "active" ] && echo "$line" | grep -q '^- '; then
      desc=$(echo "$line" | sed 's/^- //')
      sqlite3 "$DB_PATH" "
        INSERT INTO blockers (description, status) VALUES ('$(esc "$desc")', 'active');
      "
      blocker_count=$((blocker_count + 1))
    fi
  done < "$DEV_DIR/blockers.md"
  log "  Blockers: $blocker_count active blockers migrated"
  _mark_section "blockers"
fi

# ── Migrate events.log ───────────────────────────────────────────────

event_count=0
if _section_done "events"; then
  log "  Events: already migrated — skipping"
elif [ -f "$DEV_DIR/events.log" ]; then
  log "Migrating events.log..."
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    epoch=$(echo "$line" | cut -d'|' -f1)
    event=$(echo "$line" | cut -d'|' -f2)
    detail=$(echo "$line" | cut -d'|' -f3-)

    # Validate epoch is numeric
    if ! echo "$epoch" | grep -qE '^[0-9]+$'; then
      continue
    fi

    # Extract worker ID from detail if present
    wid="NULL"
    wid_match=$(echo "$detail" | sed -n 's/^[A-Za-z]* \([0-9]*\):.*/\1/p')
    if [ -n "$wid_match" ]; then
      wid="$wid_match"
    fi

    sqlite3 "$DB_PATH" "
      INSERT INTO events (epoch, event, detail, worker_id)
      VALUES ($epoch, '$(esc "$event")', '$(esc "$detail")', $wid);
    "
    event_count=$((event_count + 1))
  done < "$DEV_DIR/events.log"
  log "  Events: $event_count entries migrated"
  _mark_section "events"
fi

# ── Migrate fixer-stats.log ──────────────────────────────────────────

fixer_count=0
if _section_done "fixer_stats"; then
  log "  Fixer stats: already migrated — skipping"
elif [ -f "$DEV_DIR/fixer-stats.log" ]; then
  log "Migrating fixer-stats.log..."
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    epoch=$(echo "$line" | cut -d'|' -f1)
    result=$(echo "$line" | cut -d'|' -f2)
    title=$(echo "$line" | cut -d'|' -f3-)

    # Validate epoch
    if ! echo "$epoch" | grep -qE '^[0-9]+$'; then
      continue
    fi

    sqlite3 "$DB_PATH" "
      INSERT INTO fixer_stats (epoch, result, task_title)
      VALUES ($epoch, '$(esc "$result")', '$(esc "$title")');
    "
    fixer_count=$((fixer_count + 1))
  done < "$DEV_DIR/fixer-stats.log"
  log "  Fixer stats: $fixer_count entries migrated"
  _mark_section "fixer_stats"
fi

# ── Migrate current-task-N.md → workers table ────────────────────────

worker_count=0
for f in "$DEV_DIR"/current-task-*.md; do
  [ -f "$f" ] || continue
  wid=$(basename "$f" | sed 's/current-task-//;s/\.md//')

  # Validate wid is numeric
  if ! echo "$wid" | grep -qE '^[0-9]+$'; then
    continue
  fi

  raw=$(cat "$f")
  status=$(echo "$raw" | sed -n 's/\*\*Status:\*\* \(.*\)/\1/p')
  title=$(echo "$raw" | sed -n 's/^## \(.*\)/\1/p')
  branch=$(echo "$raw" | sed -n 's/\*\*Branch:\*\* \(.*\)/\1/p')
  started=$(echo "$raw" | sed -n 's/\*\*Started:\*\* \(.*\)/\1/p')
  info=$(echo "$raw" | sed -n 's/\*\*\(Last.*\|Note\):\*\* \(.*\)/\2/p')

  [ -z "$status" ] && status="idle"

  # Read heartbeat if available
  hb_epoch="NULL"
  if [ -f "$DEV_DIR/worker-${wid}.heartbeat" ]; then
    hb_val=$(cat "$DEV_DIR/worker-${wid}.heartbeat" | tr -d '[:space:]')
    if echo "$hb_val" | grep -qE '^[0-9]+$'; then
      hb_epoch="$hb_val"
    fi
  fi

  started_val="NULL"
  [ -n "$started" ] && started_val="'$(esc "$started")'"

  sqlite3 "$DB_PATH" "
    INSERT INTO workers (id, worker_type, status, task_title, branch, started_at, heartbeat_epoch, last_info)
    VALUES ($wid, 'dev', '$(esc "$status")', '$(esc "${title:-}")', '$(esc "${branch:-}")',
      $started_val, $hb_epoch, '$(esc "${info:-}")');
  "
  worker_count=$((worker_count + 1))
done
log "  Workers: $worker_count entries migrated"

# ── Validation ────────────────────────────────────────────────────────

log ""
log "=== Migration Summary ==="
db_tasks=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks;")
db_blockers=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM blockers;")
db_events=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM events;")
db_fixer=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM fixer_stats;")
db_workers=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM workers;")

expected_tasks=$((backlog_count + completed_count + failed_count))

log "  Tasks:       $db_tasks rows (expected $expected_tasks from $backlog_count backlog + $completed_count completed + $failed_count failed)"
log "  Blockers:    $db_blockers rows (active only)"
log "  Events:      $db_events rows"
log "  Fixer stats: $db_fixer rows"
log "  Workers:     $db_workers rows"

if [ "$db_tasks" != "$expected_tasks" ]; then
  log "WARNING: Task count mismatch! Expected $expected_tasks, got $db_tasks"
fi

log ""
log "Task status breakdown:"
sqlite3 "$DB_PATH" "SELECT status, COUNT(*) FROM tasks GROUP BY status ORDER BY COUNT(*) DESC;" | while IFS='|' read -r st cnt; do
  log "  $st: $cnt"
done

log ""
log "Database size: $(du -h "$DB_PATH" | cut -f1)"
log ""
_mark_section "ALL"
log "Migration complete! Originals backed up to $BACKUP_DIR"
log "Test with: sqlite3 $DB_PATH 'SELECT status, COUNT(*) FROM tasks GROUP BY status;'"
