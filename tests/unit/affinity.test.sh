#!/usr/bin/env bash
# tests/unit/affinity.test.sh — Unit tests for task-type affinity scoring
#
# Tests _compute_task_affinity() and _claim_task_by_id() from dev-worker.sh.
# These functions score pending tasks based on per-worker historical success
# rates by tag, preferring task types the worker excels at.
#
# Usage: bash tests/unit/affinity.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
# and set -e conflicts with functions that use pipes under pipefail.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

log()  { :; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

assert_eq() {
  local actual="$1" expected="$2" msg="$3"
  if [ "$actual" = "$expected" ]; then pass "$msg"
  else fail "$msg (expected '$expected', got '$actual')"; fi
}

assert_empty() {
  local val="$1" msg="$2"
  if [ -z "$val" ]; then pass "$msg"
  else fail "$msg (expected empty, got '$val')"; fi
}

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then pass "$msg"
  else fail "$msg (was empty)"; fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export SKYNET_PROJECT_DIR="$TMPDIR_ROOT"
export SKYNET_DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_PROJECT_NAME="test-affinity"
export SKYNET_LOCK_PREFIX="/tmp/skynet-test-affinity-$$"
export SKYNET_STALE_MINUTES=45
export SKYNET_MAX_WORKERS=2
export SKYNET_MAIN_BRANCH="main"

mkdir -p "$SKYNET_DEV_DIR"

# Source _db.sh for database helpers
source "$REPO_ROOT/scripts/_db.sh"

# Initialize the database
db_init

# ── Extract functions under test from dev-worker.sh ─────────────────
# _compute_task_affinity and _claim_task_by_id are defined inside dev-worker.sh
# which has top-level side effects. We extract just these function definitions.

eval "$(sed -n '/^_compute_task_affinity()/,/^}/p' "$REPO_ROOT/scripts/dev-worker.sh")"
eval "$(sed -n '/^_claim_task_by_id()/,/^}/p' "$REPO_ROOT/scripts/dev-worker.sh")"

# ══════════════════════════════════════════════════════════════════════
# Tests
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "=== _compute_task_affinity: no history ==="

# With no completed tasks, should return empty (FIFO fallback)
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Task A', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Task B', 'FIX', 'pending', 50);"

result=$(_compute_task_affinity 1)
assert_empty "$result" "returns empty when worker has no history"

echo ""
echo "=== _compute_task_affinity: single pending task ==="

# Even with history, affinity skips when only 1 task is pending
_db_no_out "DELETE FROM tasks;"
_db_no_out "INSERT INTO tasks (title, tag, status, priority, worker_id) VALUES ('Done FEAT', 'FEAT', 'completed', 50, 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Only pending', 'FEAT', 'pending', 50);"

result=$(_compute_task_affinity 1)
assert_empty "$result" "returns empty when only 1 task is pending"

echo ""
echo "=== _compute_task_affinity: prefers high success-rate tag ==="

_db_no_out "DELETE FROM tasks;"

# Worker 1 history: 4/5 success on FEAT, 1/5 success on FIX
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h1', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h2', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h3', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h4', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h5', 'FEAT', 'failed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h6', 'FIX', 'failed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h7', 'FIX', 'failed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h8', 'FIX', 'failed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h9', 'FIX', 'failed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h10', 'FIX', 'completed', 1);"

# Two pending tasks: one FEAT, one FIX
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending FEAT', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending FIX', 'FIX', 'pending', 50);"

result=$(_compute_task_affinity 1)
feat_id=$(_db "SELECT id FROM tasks WHERE title = 'Pending FEAT';")
assert_eq "$result" "$feat_id" "selects FEAT task (80% success) over FIX (20% success)"

echo ""
echo "=== _compute_task_affinity: tiebreak by priority ==="

_db_no_out "DELETE FROM tasks;"

# Worker 2 history: 100% on both FEAT and TEST
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h1', 'FEAT', 'completed', 2);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h2', 'TEST', 'completed', 2);"

# Two pending tasks with same tag success rate but different priorities
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Low pri FEAT', 'FEAT', 'pending', 80);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('High pri TEST', 'TEST', 'pending', 20);"

result=$(_compute_task_affinity 2)
test_id=$(_db "SELECT id FROM tasks WHERE title = 'High pri TEST';")
assert_eq "$result" "$test_id" "tiebreaks by priority (lower number = higher priority)"

echo ""
echo "=== _compute_task_affinity: unknown tag gets default score 50 ==="

_db_no_out "DELETE FROM tasks;"

# Worker 1 has 60% success on FEAT (above default 50)
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h1', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h2', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h3', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h4', 'FEAT', 'failed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h5', 'FEAT', 'failed', 1);"

# Pending: FEAT (60%) vs UNKNOWN (default 50%)
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending FEAT', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending UNKNOWN', 'DOCS', 'pending', 50);"

result=$(_compute_task_affinity 1)
feat_id=$(_db "SELECT id FROM tasks WHERE title = 'Pending FEAT';")
assert_eq "$result" "$feat_id" "prefers known high-success tag (60%) over unknown tag (default 50%)"

echo ""
echo "=== _compute_task_affinity: score at exactly 50 returns empty ==="

_db_no_out "DELETE FROM tasks;"

# Worker 1 has exactly 50% success on FEAT (not > 50, so no affinity benefit)
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h1', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h2', 'FEAT', 'failed', 1);"

# Both pending tags have 50% or default 50% — should return empty
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending FEAT', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending DOCS', 'DOCS', 'pending', 50);"

result=$(_compute_task_affinity 1)
assert_empty "$result" "returns empty when best score is exactly 50 (no advantage over default)"

echo ""
echo "=== _compute_task_affinity: ignores blocked tasks ==="

_db_no_out "DELETE FROM tasks;"

# Worker 1 has high success on FEAT
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h1', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h2', 'FEAT', 'completed', 1);"

# FEAT task is blocked, only FIX is available
_db_no_out "INSERT INTO tasks (title, tag, status, priority, blocked_by) VALUES ('Blocked FEAT', 'FEAT', 'pending', 50, 'other-task');"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Available FIX', 'FIX', 'pending', 50);"

result=$(_compute_task_affinity 1)
# Only one unblocked task, so affinity falls back (count <= 1)
assert_empty "$result" "returns empty when only 1 unblocked task after filtering blocked"

echo ""
echo "=== _compute_task_affinity: worker isolation ==="

_db_no_out "DELETE FROM tasks;"

# Worker 1 is great at FEAT, worker 2 is great at FIX
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h1', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h2', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h3', 'FIX', 'completed', 2);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h4', 'FIX', 'completed', 2);"

# Both tags pending
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending FEAT', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending FIX', 'FIX', 'pending', 50);"

result_w1=$(_compute_task_affinity 1)
feat_id=$(_db "SELECT id FROM tasks WHERE title = 'Pending FEAT';")
assert_eq "$result_w1" "$feat_id" "worker 1 prefers FEAT (its strong tag)"

result_w2=$(_compute_task_affinity 2)
fix_id=$(_db "SELECT id FROM tasks WHERE title = 'Pending FIX';")
assert_eq "$result_w2" "$fix_id" "worker 2 prefers FIX (its strong tag)"

echo ""
echo "=== _compute_task_affinity: includes 'fixed' status as success ==="

_db_no_out "DELETE FROM tasks;"

# Worker 1 has all 'fixed' status (counts as success)
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h1', 'FEAT', 'fixed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h2', 'FEAT', 'fixed', 1);"

_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending FEAT', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending FIX', 'FIX', 'pending', 50);"

result=$(_compute_task_affinity 1)
feat_id=$(_db "SELECT id FROM tasks WHERE title = 'Pending FEAT';")
assert_eq "$result" "$feat_id" "'fixed' status counts as success for affinity scoring"

echo ""
echo "=== _compute_task_affinity: empty tag in history is ignored ==="

_db_no_out "DELETE FROM tasks;"

# Worker has history with empty tag — should be ignored
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h1', '', 'completed', 1);"

_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending A', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending B', 'FIX', 'pending', 50);"

result=$(_compute_task_affinity 1)
assert_empty "$result" "returns empty when history has only empty tags"

echo ""
echo "=== _compute_task_affinity: tags are matched literally (no regex expansion) ==="

_db_no_out "DELETE FROM tasks;"

# Worker 1 is strong on literal "FEAT.*" and weak on "FEAT"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h1', 'FEAT.*', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h2', 'FEAT.*', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h3', 'FEAT', 'failed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h4', 'FEAT', 'failed', 1);"

_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending regex-literal', 'FEAT.*', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Pending plain', 'FEAT', 'pending', 50);"

result=$(_compute_task_affinity 1)
literal_id=$(_db "SELECT id FROM tasks WHERE title = 'Pending regex-literal';")
assert_eq "$result" "$literal_id" "uses exact tag match when tag contains regex metacharacters"

echo ""
echo "=== _claim_task_by_id: claims a specific task ==="

_db_no_out "DELETE FROM tasks;"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Claim me', 'FEAT', 'pending', 50);"
task_id=$(_db "SELECT id FROM tasks WHERE title = 'Claim me';")

result=$(_claim_task_by_id 1 "$task_id")
assert_not_empty "$result" "returns task data after successful claim"

status=$(_db "SELECT status FROM tasks WHERE id = $task_id;")
assert_eq "$status" "claimed" "task status changes to 'claimed'"

worker=$(_db "SELECT worker_id FROM tasks WHERE id = $task_id;")
assert_eq "$worker" "1" "task is assigned to correct worker"

echo ""
echo "=== _claim_task_by_id: fails for non-pending task ==="

_db_no_out "DELETE FROM tasks;"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('Already done', 'FEAT', 'completed', 50);"
task_id=$(_db "SELECT id FROM tasks WHERE title = 'Already done';")

result=$(_claim_task_by_id 1 "$task_id")
assert_empty "$result" "returns empty for non-pending task"

status=$(_db "SELECT status FROM tasks WHERE id = $task_id;")
assert_eq "$status" "completed" "does not change status of non-pending task"

echo ""
echo "=== _claim_task_by_id: returns correct field format ==="

_db_no_out "DELETE FROM tasks;"
_db_no_out "INSERT INTO tasks (title, tag, status, priority, description, branch) VALUES ('Format test', 'TEST', 'pending', 50, 'A description', 'dev/format');"
task_id=$(_db "SELECT id FROM tasks WHERE title = 'Format test';")

result=$(_claim_task_by_id 1 "$task_id")
# Result should contain: id, title, tag, description, branch separated by \x1f
echo "$result" | grep -qF "Format test"
rc=$?
if [ "$rc" -eq 0 ]; then pass "result contains task title"
else fail "result should contain task title"; fi

echo "$result" | grep -qF "TEST"
rc=$?
if [ "$rc" -eq 0 ]; then pass "result contains task tag"
else fail "result should contain task tag"; fi

echo "$result" | grep -qF "A description"
rc=$?
if [ "$rc" -eq 0 ]; then pass "result contains task description"
else fail "result should contain task description"; fi

echo ""
echo "=== _compute_task_affinity: cleans up temp files ==="

_db_no_out "DELETE FROM tasks;"
_db_no_out "INSERT INTO tasks (title, tag, status, worker_id) VALUES ('h1', 'FEAT', 'completed', 1);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('P1', 'FEAT', 'pending', 50);"
_db_no_out "INSERT INTO tasks (title, tag, status, priority) VALUES ('P2', 'FIX', 'pending', 50);"

_compute_task_affinity 1 >/dev/null
# Check that affinity temp file was cleaned up
affinity_file="/tmp/skynet-affinity-1-$$"
if [ ! -f "$affinity_file" ]; then pass "affinity temp file cleaned up after computation"
else fail "affinity temp file leaked: $affinity_file"; rm -f "$affinity_file"; fi

# ══════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "──────────────────────────────────────────"
printf "  Results: \033[32m%d passed\033[0m" "$PASS"
if [ "$FAIL" -gt 0 ]; then
  printf ", \033[31m%d failed\033[0m" "$FAIL"
fi
echo ""
echo "──────────────────────────────────────────"

exit "$FAIL"
