#!/usr/bin/env bash
# tests/unit/failure-analyzer-patterns.test.sh — Unit tests for failure-analyzer.sh
# pattern matching, counting, and error classification logic.
#
# Tests:
#   - _classify_error edge cases (case sensitivity, substring positioning, combined errors)
#   - _count_error increments per-category counters correctly
#   - _count_status increments outcome counters correctly
#   - _count_attempts distributes attempts into buckets
#   - Top error pattern detection from collected messages
#
# Usage: bash tests/unit/failure-analyzer-patterns.test.sh

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
  if [ "$actual" = "$expected" ]; then pass "$msg"
  else fail "$msg (expected '$expected', got '$actual')"; fi
}

# ── Source functions under test ──────────────────────────────────
# These are copied from failure-analyzer.sh since it runs top-to-bottom.

_classify_error() {
  local err="$1"
  case "$err" in
    *"merge conflict"*)    echo "merge_conflict" ;;
    *"typecheck failed"*)  echo "typecheck" ;;
    *"typecheck"*"fail"*)  echo "typecheck" ;;
    *"claude exit code"*)  echo "agent_failed" ;;
    *"agent"*"fail"*)      echo "agent_failed" ;;
    *"worktree missing"*)  echo "worktree_missing" ;;
    *"gate"*"fail"*)       echo "gate_failed" ;;
    *"usage limit"*)       echo "usage_limit" ;;
    *"all agents hit"*)    echo "usage_limit" ;;
    *)                     echo "other" ;;
  esac
}

merge_conflict=0
typecheck_failed=0
agent_failed=0
worktree_missing=0
gate_failed=0
usage_limit=0
other_errors=0

_count_error() {
  local cat="$1"
  case "$cat" in
    merge_conflict)  merge_conflict=$((merge_conflict + 1)) ;;
    typecheck)       typecheck_failed=$((typecheck_failed + 1)) ;;
    agent_failed)    agent_failed=$((agent_failed + 1)) ;;
    worktree_missing) worktree_missing=$((worktree_missing + 1)) ;;
    gate_failed)     gate_failed=$((gate_failed + 1)) ;;
    usage_limit)     usage_limit=$((usage_limit + 1)) ;;
    other)           other_errors=$((other_errors + 1)) ;;
  esac
}

fixed_count=0
superseded_count=0
blocked_count=0
still_failed=0

_count_status() {
  local st="$1"
  case "$st" in
    fixed)      fixed_count=$((fixed_count + 1)) ;;
    superseded) superseded_count=$((superseded_count + 1)) ;;
    blocked)    blocked_count=$((blocked_count + 1)) ;;
    failed)     still_failed=$((still_failed + 1)) ;;
  esac
}

attempt_0=0
attempt_1=0
attempt_2=0
attempt_3_plus=0

_count_attempts() {
  local att="$1"
  case "$att" in
    0) attempt_0=$((attempt_0 + 1)) ;;
    1) attempt_1=$((attempt_1 + 1)) ;;
    2) attempt_2=$((attempt_2 + 1)) ;;
    *) attempt_3_plus=$((attempt_3_plus + 1)) ;;
  esac
}

_error_messages=""
_record_error_msg() {
  local msg="$1"
  msg="${msg:0:120}"
  _error_messages="${_error_messages}${msg}"$'\n'
}

# ============================================================
# TESTS
# ============================================================

echo ""
log "=== _classify_error: edge cases and substring matching ==="

# Basic patterns (sanity)
assert_eq "$(_classify_error "merge conflict on file X")" "merge_conflict" \
  "basic: merge conflict"
assert_eq "$(_classify_error "typecheck failed with 3 errors")" "typecheck" \
  "basic: typecheck failed"
assert_eq "$(_classify_error "claude exit code 1")" "agent_failed" \
  "basic: claude exit code"
assert_eq "$(_classify_error "worktree missing at /tmp/xyz")" "worktree_missing" \
  "basic: worktree missing"
assert_eq "$(_classify_error "quality gate failed")" "gate_failed" \
  "basic: gate failed"
assert_eq "$(_classify_error "usage limit reached")" "usage_limit" \
  "basic: usage limit"
assert_eq "$(_classify_error "all agents hit rate limit")" "usage_limit" \
  "basic: all agents hit"

# Substring positioning — pattern can appear anywhere in the string
assert_eq "$(_classify_error "ERROR: critical merge conflict detected in src/index.ts")" "merge_conflict" \
  "merge conflict embedded in longer string"
assert_eq "$(_classify_error "step 3: typecheck failed — retrying")" "typecheck" \
  "typecheck failed in middle of string"
assert_eq "$(_classify_error "fatal: worktree missing — cannot proceed")" "worktree_missing" \
  "worktree missing with prefix and suffix"

# The typecheck...fail split pattern
assert_eq "$(_classify_error "typecheck will fail on strict")" "typecheck" \
  "split pattern: typecheck...fail"
assert_eq "$(_classify_error "typecheck: 5 errors, build failed")" "typecheck" \
  "split pattern: typecheck...failed (with content between)"
assert_eq "$(_classify_error "running typecheck... compilation failure detected")" "typecheck" \
  "split pattern: typecheck...failure (fail substring)"

# The agent...fail split pattern
assert_eq "$(_classify_error "the agent has failed after timeout")" "agent_failed" \
  "split pattern: agent...failed"
assert_eq "$(_classify_error "agent process failure on worker 3")" "agent_failed" \
  "split pattern: agent...failure"

# The gate...fail split pattern
assert_eq "$(_classify_error "quality gate check failure")" "gate_failed" \
  "split pattern: gate...failure"
assert_eq "$(_classify_error "the gate script failed with code 2")" "gate_failed" \
  "split pattern: gate...failed"

# Case sensitivity — bash case is case-sensitive by default
assert_eq "$(_classify_error "Merge Conflict on file X")" "other" \
  "case sensitive: 'Merge Conflict' not matched (uppercase)"
assert_eq "$(_classify_error "TYPECHECK FAILED")" "other" \
  "case sensitive: 'TYPECHECK FAILED' not matched (all caps)"
assert_eq "$(_classify_error "Usage Limit exceeded")" "other" \
  "case sensitive: 'Usage Limit' not matched (title case)"

# Empty and whitespace
assert_eq "$(_classify_error "")" "other" \
  "empty string classified as other"
assert_eq "$(_classify_error "   ")" "other" \
  "whitespace-only classified as other"

# No false positives — similar but non-matching strings
assert_eq "$(_classify_error "the merger completed successfully")" "other" \
  "no false positive: 'merger' is not 'merge conflict'"
assert_eq "$(_classify_error "typechecking passed")" "other" \
  "no false positive: 'typechecking passed' has no fail"
assert_eq "$(_classify_error "gate opened successfully")" "other" \
  "no false positive: 'gate opened' has no fail"
assert_eq "$(_classify_error "usage was within limits")" "other" \
  "no false positive: 'usage was within limits'"

# Priority: first match wins (merge conflict before typecheck)
assert_eq "$(_classify_error "merge conflict caused typecheck failed")" "merge_conflict" \
  "priority: merge conflict wins over typecheck failed"
assert_eq "$(_classify_error "typecheck failed, claude exit code 1")" "typecheck" \
  "priority: typecheck failed wins over claude exit code"


echo ""
log "=== _count_error: category counter increments ==="

# Reset
merge_conflict=0; typecheck_failed=0; agent_failed=0
worktree_missing=0; gate_failed=0; usage_limit=0; other_errors=0

_count_error "merge_conflict"
_count_error "merge_conflict"
assert_eq "$merge_conflict" "2" "merge_conflict counter = 2"

_count_error "typecheck"
_count_error "typecheck"
_count_error "typecheck"
assert_eq "$typecheck_failed" "3" "typecheck_failed counter = 3"

_count_error "agent_failed"
assert_eq "$agent_failed" "1" "agent_failed counter = 1"

_count_error "worktree_missing"
assert_eq "$worktree_missing" "1" "worktree_missing counter = 1"

_count_error "gate_failed"
assert_eq "$gate_failed" "1" "gate_failed counter = 1"

_count_error "usage_limit"
_count_error "usage_limit"
assert_eq "$usage_limit" "2" "usage_limit counter = 2"

_count_error "other"
_count_error "other"
_count_error "other"
_count_error "other"
assert_eq "$other_errors" "4" "other_errors counter = 4"

# Unknown category doesn't increment anything
_count_error "nonexistent"
assert_eq "$merge_conflict" "2" "unknown category does not affect merge_conflict"
assert_eq "$other_errors" "4" "unknown category does not affect other_errors"


echo ""
log "=== _count_status: outcome counter increments ==="

# Reset
fixed_count=0; superseded_count=0; blocked_count=0; still_failed=0

_count_status "fixed"
_count_status "fixed"
_count_status "fixed"
assert_eq "$fixed_count" "3" "fixed counter = 3"

_count_status "superseded"
assert_eq "$superseded_count" "1" "superseded counter = 1"

_count_status "blocked"
_count_status "blocked"
assert_eq "$blocked_count" "2" "blocked counter = 2"

_count_status "failed"
assert_eq "$still_failed" "1" "still_failed counter = 1"

# Unknown status doesn't increment anything
_count_status "pending"
_count_status "claimed"
assert_eq "$fixed_count" "3" "unknown status does not affect fixed"
assert_eq "$still_failed" "1" "unknown status does not affect still_failed"


echo ""
log "=== _count_attempts: attempt bucket distribution ==="

# Reset
attempt_0=0; attempt_1=0; attempt_2=0; attempt_3_plus=0

_count_attempts "0"
_count_attempts "0"
assert_eq "$attempt_0" "2" "attempt_0 bucket = 2"

_count_attempts "1"
assert_eq "$attempt_1" "1" "attempt_1 bucket = 1"

_count_attempts "2"
_count_attempts "2"
_count_attempts "2"
assert_eq "$attempt_2" "3" "attempt_2 bucket = 3"

_count_attempts "3"
_count_attempts "4"
_count_attempts "5"
_count_attempts "10"
assert_eq "$attempt_3_plus" "4" "attempt_3_plus bucket = 4 (values 3,4,5,10)"

# Non-numeric goes to 3+ bucket (default case)
_count_attempts "abc"
assert_eq "$attempt_3_plus" "5" "non-numeric attempt goes to 3+ bucket"


echo ""
log "=== _record_error_msg: message collection and truncation ==="

_error_messages=""

_record_error_msg "short error"
_record_error_msg "another error"
assert_eq "$(printf '%s' "$_error_messages" | grep -c "error")" "2" \
  "two error messages recorded"

# Truncation at 120 chars
_long_msg="$(printf 'x%.0s' $(seq 1 200))"
_record_error_msg "$_long_msg"
_last_line="$(printf '%s' "$_error_messages" | tail -1)"
_last_len="${#_last_line}"
if [ "$_last_len" -le 120 ]; then
  pass "long message truncated to <= 120 chars (got $_last_len)"
else
  fail "long message not truncated (got $_last_len chars)"
fi


echo ""
log "=== Top error pattern detection ==="

_error_messages=""

# Simulate 5 typecheck failures, 3 merge conflicts, 1 usage limit
for i in 1 2 3 4 5; do
  _record_error_msg "typecheck failed with errors in module $i"
done
for i in 1 2 3; do
  _record_error_msg "merge conflict on file $i"
done
_record_error_msg "hit usage limit for key abc"

# Replicate the top error pattern detection logic from failure-analyzer.sh
_top_error=""
_top_error_count=0
for _pattern in "merge conflict" "typecheck failed" "claude exit code" "worktree missing" "usage limit"; do
  _pc=$(printf '%s\n' "$_error_messages" | grep -ci "$_pattern" 2>/dev/null || echo "0")
  _pc="${_pc%%[!0-9]*}"
  _pc="${_pc:-0}"
  if [ "$_pc" -gt "$_top_error_count" ]; then
    _top_error_count=$_pc
    _top_error="$_pattern"
  fi
done

assert_eq "$_top_error" "typecheck failed" \
  "top pattern is 'typecheck failed' (5 occurrences)"
assert_eq "$_top_error_count" "5" \
  "top pattern count is 5"

# When no patterns match at all
_error_messages=""
_record_error_msg "completely unknown error foo"
_record_error_msg "another mystery bar"

_top_error=""
_top_error_count=0
for _pattern in "merge conflict" "typecheck failed" "claude exit code" "worktree missing" "usage limit"; do
  _pc=$(printf '%s\n' "$_error_messages" | grep -ci "$_pattern" 2>/dev/null || echo "0")
  _pc="${_pc%%[!0-9]*}"
  _pc="${_pc:-0}"
  if [ "$_pc" -gt "$_top_error_count" ]; then
    _top_error_count=$_pc
    _top_error="$_pattern"
  fi
done

assert_eq "$_top_error" "" "no top pattern when nothing matches"
assert_eq "$_top_error_count" "0" "top count is 0 when nothing matches"


echo ""
log "=== End-to-end: classify -> count -> fix rate ==="

# Reset all counters
merge_conflict=0; typecheck_failed=0; agent_failed=0
worktree_missing=0; gate_failed=0; usage_limit=0; other_errors=0
fixed_count=0; superseded_count=0; blocked_count=0; still_failed=0
attempt_0=0; attempt_1=0; attempt_2=0; attempt_3_plus=0
total_failures=0

# Simulate processing a batch of failure records
_test_errors=(
  "merge conflict on package-lock.json"
  "typecheck failed with 12 errors"
  "typecheck failed on strict mode"
  "claude exit code 1 after timeout"
  "some unknown error happened"
  "worktree missing at /tmp/skynet-proj-worktree-1"
  "quality gate failed on lint step"
  "usage limit reached for key XYZ"
  "all agents hit rate ceiling"
  "merge conflict on src/index.ts"
)
_test_statuses=(
  "fixed" "fixed" "failed" "blocked" "superseded"
  "fixed" "failed" "blocked" "failed" "fixed"
)
_test_attempts=(
  "1" "0" "2" "3" "0" "1" "2" "0" "4" "1"
)

for i in $(seq 0 9); do
  total_failures=$((total_failures + 1))
  _cat=$(_classify_error "${_test_errors[$i]}")
  _count_error "$_cat"
  _count_status "${_test_statuses[$i]}"
  _count_attempts "${_test_attempts[$i]}"
done

assert_eq "$total_failures" "10" "e2e: 10 total failures processed"
assert_eq "$merge_conflict" "2" "e2e: 2 merge conflicts"
assert_eq "$typecheck_failed" "2" "e2e: 2 typecheck failures"
assert_eq "$agent_failed" "1" "e2e: 1 agent failure"
assert_eq "$worktree_missing" "1" "e2e: 1 worktree missing"
assert_eq "$gate_failed" "1" "e2e: 1 gate failure"
assert_eq "$usage_limit" "2" "e2e: 2 usage limit (including 'all agents hit')"
assert_eq "$other_errors" "1" "e2e: 1 other error"

assert_eq "$fixed_count" "4" "e2e: 4 fixed"
assert_eq "$superseded_count" "1" "e2e: 1 superseded"
assert_eq "$blocked_count" "2" "e2e: 2 blocked"
assert_eq "$still_failed" "3" "e2e: 3 still failed"

assert_eq "$attempt_0" "3" "e2e: 3 at attempt 0"
assert_eq "$attempt_1" "3" "e2e: 3 at attempt 1"
assert_eq "$attempt_2" "2" "e2e: 2 at attempt 2"
assert_eq "$attempt_3_plus" "2" "e2e: 2 at attempt 3+"

# Fix rate calculation
fix_rate=$(( (fixed_count * 100) / total_failures ))
assert_eq "$fix_rate" "40" "e2e: fix rate is 40%"


# ============================================================
# SUMMARY
# ============================================================

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
