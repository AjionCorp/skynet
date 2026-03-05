#!/usr/bin/env bash
# tests/unit/clean-logs.test.sh — Unit tests for scripts/clean-logs.sh
#
# Tests log trimming (24h cutoff, size threshold), events.log rotation
# (cascade, threshold), and old backup cleanup.
#
# Usage: bash tests/unit/clean-logs.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

log()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

assert_eq() {
  local actual="$1" expected="$2" msg="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$msg"
  else
    fail "$msg (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle')"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

MOCK_SCRIPTS_DIR="$TMPDIR_ROOT/scripts"
MOCK_DEV_DIR="$TMPDIR_ROOT/.dev"
mkdir -p "$MOCK_SCRIPTS_DIR" "$MOCK_DEV_DIR"

# Create a minimal _config.sh stub in the mock scripts dir.
# clean-logs.sh sources _config.sh relative to its own location,
# so we place the stub alongside our copy of the script.
cat > "$MOCK_SCRIPTS_DIR/_config.sh" << STUB
# Stub _config.sh — provides only what clean-logs.sh needs
SCRIPTS_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="\$SCRIPTS_DIR"
DEV_DIR="\$(dirname "\$SCRIPTS_DIR")/.dev"

# Source real _compat.sh for file_size and date_24h_ago
source "$REPO_ROOT/scripts/_compat.sh"

# Allow tests to override date_24h_ago via environment variable
if [ -n "\${_TEST_CUTOFF:-}" ]; then
  date_24h_ago() { echo "\$_TEST_CUTOFF"; }
fi
STUB

# Copy clean-logs.sh into the mock scripts dir so it sources our stub _config.sh
cp "$REPO_ROOT/scripts/clean-logs.sh" "$MOCK_SCRIPTS_DIR/clean-logs.sh"

# Helper: generate a log file with timestamped lines reaching a target size
# Usage: generate_log <path> <min_bytes> <timestamp_prefix> [<extra_lines_ts>]
generate_log() {
  local path="$1" min_bytes="$2" ts="$3" extra_ts="${4:-}"
  local padding
  padding=$(printf '%0200d' 0)  # 200-char padding line

  : > "$path"
  # Write lines with the primary timestamp until we hit size threshold
  local i=0
  while [ "$(file_size "$path")" -lt "$min_bytes" ]; do
    echo "[$ts] Line $i $padding" >> "$path"
    i=$((i + 1))
  done

  # Append extra lines with a different timestamp if provided
  if [ -n "$extra_ts" ]; then
    local j=0
    while [ "$j" -lt 20 ]; do
      echo "[$extra_ts] Extra line $j $padding" >> "$path"
      j=$((j + 1))
    done
  fi
}

# Source real _compat.sh for file_size used in helpers
source "$REPO_ROOT/scripts/_compat.sh"

# ── Test 1: Skip small files (< 50KB) ──────────────────────────────

echo ""
log "=== Log trimming: skip small files ==="

# Create a small log file with old timestamps
SMALL_LOG="$MOCK_SCRIPTS_DIR/small.log"
echo "[2020-01-01 00:00:00] Old line" > "$SMALL_LOG"
small_before=$(cat "$SMALL_LOG")

# Override date_24h_ago to return a known cutoff
export _TEST_CUTOFF="2025-01-01 00:00:00"

# Run clean-logs.sh
bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null

small_after=$(cat "$SMALL_LOG")
assert_eq "$small_after" "$small_before" "skip small files: file under 50KB is unchanged"

# ── Test 2: Trim old lines from large log file ─────────────────────

echo ""
log "=== Log trimming: trim old lines, keep recent ==="

LARGE_LOG="$MOCK_SCRIPTS_DIR/worker.log"
OLD_TS="2024-06-01 12:00:00"
NEW_TS="2025-06-01 12:00:00"

# Generate a large file: old lines first, then new lines
generate_log "$LARGE_LOG" 60000 "$OLD_TS" "$NEW_TS"

lines_before=$(wc -l < "$LARGE_LOG" | tr -d ' ')

# Override date_24h_ago so old lines are before cutoff, new lines are after
export _TEST_CUTOFF="2025-01-01 00:00:00"

bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null

lines_after=$(wc -l < "$LARGE_LOG" | tr -d ' ')

# After trimming, old lines should be gone — only new lines remain
if [ "$lines_after" -lt "$lines_before" ]; then
  pass "trim old lines: file was trimmed ($lines_before -> $lines_after lines)"
else
  fail "trim old lines: file should have fewer lines after trimming ($lines_before -> $lines_after)"
fi

# Verify remaining lines have the new timestamp
if grep -q "\[$OLD_TS\]" "$LARGE_LOG" 2>/dev/null; then
  fail "trim old lines: old timestamp lines should be removed"
else
  pass "trim old lines: no old timestamp lines remain"
fi

if grep -q "\[$NEW_TS\]" "$LARGE_LOG" 2>/dev/null; then
  pass "trim old lines: new timestamp lines preserved"
else
  fail "trim old lines: new timestamp lines should be preserved"
fi

# ── Test 3: All lines are recent — no trimming ─────────────────────

echo ""
log "=== Log trimming: all lines recent — no trimming ==="

FRESH_LOG="$MOCK_SCRIPTS_DIR/fresh.log"
FRESH_TS="2025-06-15 08:00:00"
generate_log "$FRESH_LOG" 60000 "$FRESH_TS"

lines_before=$(wc -l < "$FRESH_LOG" | tr -d ' ')

export _TEST_CUTOFF="2025-01-01 00:00:00"

bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null

lines_after=$(wc -l < "$FRESH_LOG" | tr -d ' ')

assert_eq "$lines_after" "$lines_before" "all lines recent: file is unchanged ($lines_before lines)"

# ── Test 4: First fresh line at line <= 10 — no trimming ───────────

echo ""
log "=== Log trimming: first fresh line at line <= 10 — no trimming ==="

EARLY_LOG="$MOCK_SCRIPTS_DIR/early.log"
: > "$EARLY_LOG"
padding=$(printf '%0200d' 0)

# Write 5 old lines, then many new lines to exceed 50KB
for i in $(seq 1 5); do
  echo "[2024-01-01 00:00:00] Old line $i $padding" >> "$EARLY_LOG"
done
while [ "$(file_size "$EARLY_LOG")" -lt 60000 ]; do
  echo "[2025-06-01 12:00:00] New line $padding" >> "$EARLY_LOG"
done

lines_before=$(wc -l < "$EARLY_LOG" | tr -d ' ')

export _TEST_CUTOFF="2025-01-01 00:00:00"

bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null

lines_after=$(wc -l < "$EARLY_LOG" | tr -d ' ')

# first_line would be 6, which is <= 10, so no trimming
assert_eq "$lines_after" "$lines_before" "first fresh line <= 10: file is unchanged"

# ── Test 5: No timestamp lines in file — no trimming ───────────────

echo ""
log "=== Log trimming: no timestamp lines — no trimming ==="

NOTS_LOG="$MOCK_SCRIPTS_DIR/no-timestamps.log"
: > "$NOTS_LOG"
while [ "$(file_size "$NOTS_LOG")" -lt 60000 ]; do
  echo "Just a plain line with no bracket timestamp $padding" >> "$NOTS_LOG"
done

lines_before=$(wc -l < "$NOTS_LOG" | tr -d ' ')

bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null

lines_after=$(wc -l < "$NOTS_LOG" | tr -d ' ')
assert_eq "$lines_after" "$lines_before" "no timestamps: file is unchanged"

# ── Test 6: No .tmp files left after trimming ──────────────────────

echo ""
log "=== Log trimming: no .tmp files left after trimming ==="

tmp_count=$(find "$MOCK_SCRIPTS_DIR" -name "*.tmp" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "$tmp_count" "0" "no leftover .tmp files in scripts dir"

# ── Clean up log files before events.log tests ─────────────────────
rm -f "$MOCK_SCRIPTS_DIR"/*.log "$MOCK_SCRIPTS_DIR"/*.log.tmp

# ── Test 7: Events log rotation — file exceeds threshold ───────────

echo ""
log "=== Events log rotation: rotate when exceeding threshold ==="

EVENTS_LOG="$MOCK_DEV_DIR/events.log"

# Set a low threshold for testing (2 KB)
export SKYNET_MAX_EVENTS_LOG_KB=2

# Create events.log larger than 2KB
: > "$EVENTS_LOG"
while [ "$(file_size "$EVENTS_LOG")" -lt 3000 ]; do
  echo "event line $padding" >> "$EVENTS_LOG"
done

bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null

if [ -f "${EVENTS_LOG}.1" ]; then
  pass "events rotation: events.log rotated to events.log.1"
else
  fail "events rotation: events.log.1 should exist after rotation"
fi

if [ -f "$EVENTS_LOG" ]; then
  fail "events rotation: events.log should be moved (not remain)"
else
  pass "events rotation: original events.log removed after rotation"
fi

# ── Test 8: Events log rotation — cascade .1 → .2 ──────────────────

echo ""
log "=== Events log rotation: cascade .1 → .2 ==="

# Set up: events.log.1 exists, create new large events.log
echo "previous rotation content" > "${EVENTS_LOG}.1"

: > "$EVENTS_LOG"
while [ "$(file_size "$EVENTS_LOG")" -lt 3000 ]; do
  echo "new event line $padding" >> "$EVENTS_LOG"
done

bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null

if [ -f "${EVENTS_LOG}.2" ]; then
  content_2=$(cat "${EVENTS_LOG}.2")
  assert_contains "$content_2" "previous rotation content" "cascade: .1 content moved to .2"
else
  fail "cascade: events.log.2 should exist after cascade rotation"
fi

if [ -f "${EVENTS_LOG}.1" ]; then
  pass "cascade: new events.log.1 created from current"
else
  fail "cascade: events.log.1 should exist after rotation"
fi

# ── Test 9: Events log rotation — .2 is replaced ───────────────────

echo ""
log "=== Events log rotation: .2 is replaced on cascade ==="

# Set up: both .1 and .2 exist, create new large events.log
echo "old-backup-2" > "${EVENTS_LOG}.2"
echo "old-backup-1" > "${EVENTS_LOG}.1"

: > "$EVENTS_LOG"
while [ "$(file_size "$EVENTS_LOG")" -lt 3000 ]; do
  echo "newest event $padding" >> "$EVENTS_LOG"
done

bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null

content_2=$(cat "${EVENTS_LOG}.2" 2>/dev/null || echo "")
assert_contains "$content_2" "old-backup-1" ".2 replaced: contains former .1 content"

# ── Test 10: Events log rotation — under threshold, no rotation ─────

echo ""
log "=== Events log rotation: under threshold — no rotation ==="

rm -f "${EVENTS_LOG}" "${EVENTS_LOG}.1" "${EVENTS_LOG}.2"

# Create a small events.log (under 2KB threshold)
echo "small event" > "$EVENTS_LOG"

bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null

if [ -f "$EVENTS_LOG" ]; then
  pass "under threshold: events.log still exists"
else
  fail "under threshold: events.log should not be rotated"
fi

if [ -f "${EVENTS_LOG}.1" ]; then
  fail "under threshold: events.log.1 should not be created"
else
  pass "under threshold: no rotation occurred"
fi

# ── Test 11: Old backup cleanup — stale .log.[12] files ────────────

echo ""
log "=== Old backup cleanup: stale rotated files removed ==="

rm -f "${EVENTS_LOG}" "${EVENTS_LOG}.1" "${EVENTS_LOG}.2"

# Create old rotated backup files (> 24h old)
OLD_BACKUP_S="$MOCK_SCRIPTS_DIR/test.log.1"
OLD_BACKUP_D="$MOCK_DEV_DIR/test.log.2"
echo "stale backup" > "$OLD_BACKUP_S"
echo "stale backup" > "$OLD_BACKUP_D"

# Backdate to 2 days ago
if [ "$(uname -s)" = "Darwin" ]; then
  touch -t "$(date -v-2d '+%Y%m%d%H%M.%S')" "$OLD_BACKUP_S" "$OLD_BACKUP_D"
else
  touch -d "2 days ago" "$OLD_BACKUP_S" "$OLD_BACKUP_D"
fi

bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null

if [ -f "$OLD_BACKUP_S" ]; then
  fail "stale cleanup: old scripts/*.log.1 should be removed"
else
  pass "stale cleanup: old scripts/*.log.1 removed"
fi

if [ -f "$OLD_BACKUP_D" ]; then
  fail "stale cleanup: old .dev/*.log.2 should be removed"
else
  pass "stale cleanup: old .dev/*.log.2 removed"
fi

# ── Test 12: Old backup cleanup — fresh backups preserved ───────────

echo ""
log "=== Old backup cleanup: fresh rotated files preserved ==="

FRESH_BACKUP_S="$MOCK_SCRIPTS_DIR/recent.log.1"
FRESH_BACKUP_D="$MOCK_DEV_DIR/recent.log.2"
echo "fresh backup" > "$FRESH_BACKUP_S"
echo "fresh backup" > "$FRESH_BACKUP_D"

bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null

if [ -f "$FRESH_BACKUP_S" ]; then
  pass "fresh backups: scripts/*.log.1 preserved"
else
  fail "fresh backups: fresh scripts/*.log.1 should be preserved"
fi

if [ -f "$FRESH_BACKUP_D" ]; then
  pass "fresh backups: .dev/*.log.2 preserved"
else
  fail "fresh backups: fresh .dev/*.log.2 should be preserved"
fi

# ── Test 13: Events log missing — no error ──────────────────────────

echo ""
log "=== Events log rotation: missing events.log — no error ==="

rm -f "$EVENTS_LOG" "${EVENTS_LOG}.1" "${EVENTS_LOG}.2"

# Should not error when events.log doesn't exist
if bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null; then
  pass "missing events.log: script completes without error"
else
  fail "missing events.log: script should not fail"
fi

# ── Test 14: Empty scripts dir — no error ───────────────────────────

echo ""
log "=== Log trimming: empty scripts dir (no .log files) — no error ==="

# Remove all log files
rm -f "$MOCK_SCRIPTS_DIR"/*.log "$MOCK_SCRIPTS_DIR"/*.log.[12]

if bash "$MOCK_SCRIPTS_DIR/clean-logs.sh" 2>/dev/null; then
  pass "empty scripts dir: script completes without error"
else
  fail "empty scripts dir: script should not fail with no log files"
fi

# ── Summary ──────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
