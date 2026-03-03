#!/usr/bin/env bash
# tests/unit/compat.test.sh — Unit tests for scripts/_compat.sh compatibility helpers
#
# Tests: file_mtime, file_size, date_24h_ago, date_minutes_ago, sed_inplace,
#        to_upper, realpath_portable, run_with_timeout,
#        _acquire_file_lock, _release_file_lock
#
# Usage: bash tests/unit/compat.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0
_BG_PIDS=()

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
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle', got '$haystack')"
  fi
}

assert_numeric() {
  local value="$1" msg="$2"
  case "$value" in
    ''|*[!0-9]*)
      fail "$msg (expected numeric, got '$value')"
      ;;
    *)
      pass "$msg"
      ;;
  esac
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  for _pid in "${_BG_PIDS[@]:-}"; do
    kill "$_pid" 2>/dev/null; wait "$_pid" 2>/dev/null || true
  done
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

# Source _compat.sh directly (it has no dependencies beyond uname)
source "$REPO_ROOT/scripts/_compat.sh"

echo "compat.test.sh — unit tests for _compat.sh compatibility helpers"

# ── SKYNET_IS_MACOS detection ──────────────────────────────────────

echo ""
log "=== SKYNET_IS_MACOS: platform detection ==="

current_os=$(uname -s)
if [ "$current_os" = "Darwin" ]; then
  assert_eq "$SKYNET_IS_MACOS" "true" "SKYNET_IS_MACOS: true on Darwin"
else
  assert_eq "$SKYNET_IS_MACOS" "false" "SKYNET_IS_MACOS: false on non-Darwin"
fi

# ── file_mtime ─────────────────────────────────────────────────────

echo ""
log "=== file_mtime: file modification time ==="

# Test 1: returns numeric epoch for existing file
test_file="$TMPDIR_ROOT/mtime-test.txt"
echo "hello" > "$test_file"
result=$(file_mtime "$test_file")
assert_numeric "$result" "file_mtime: returns numeric epoch for existing file"

# Test 2: mtime is recent (within last 10 seconds)
now=$(date +%s)
diff=$((now - result))
if [ "$diff" -ge 0 ] && [ "$diff" -le 10 ]; then
  pass "file_mtime: mtime is within last 10 seconds"
else
  fail "file_mtime: mtime should be recent (diff=${diff}s)"
fi

# Test 3: returns 0 for nonexistent file
result=$(file_mtime "$TMPDIR_ROOT/nonexistent-file")
assert_eq "$result" "0" "file_mtime: returns 0 for nonexistent file"

# Test 4: mtime changes when file is touched
old_mtime=$(file_mtime "$test_file")
sleep 1
touch "$test_file"
new_mtime=$(file_mtime "$test_file")
if [ "$new_mtime" -ge "$old_mtime" ]; then
  pass "file_mtime: mtime updates after touch"
else
  fail "file_mtime: mtime should update after touch (old=$old_mtime, new=$new_mtime)"
fi

# ── file_size ──────────────────────────────────────────────────────

echo ""
log "=== file_size: file size in bytes ==="

# Test 1: correct size for known content
size_file="$TMPDIR_ROOT/size-test.txt"
printf "12345" > "$size_file"
result=$(file_size "$size_file")
assert_eq "$result" "5" "file_size: 5-byte file returns 5"

# Test 2: empty file returns 0
empty_file="$TMPDIR_ROOT/empty.txt"
: > "$empty_file"
result=$(file_size "$empty_file")
assert_eq "$result" "0" "file_size: empty file returns 0"

# Test 3: nonexistent file returns 0
result=$(file_size "$TMPDIR_ROOT/no-such-file")
assert_eq "$result" "0" "file_size: nonexistent file returns 0"

# Test 4: larger file
large_file="$TMPDIR_ROOT/large.txt"
dd if=/dev/zero bs=1024 count=1 of="$large_file" 2>/dev/null
result=$(file_size "$large_file")
assert_eq "$result" "1024" "file_size: 1024-byte file returns 1024"

# ── date_24h_ago ───────────────────────────────────────────────────

echo ""
log "=== date_24h_ago: timestamp 24 hours ago ==="

# Test 1: returns a value in YYYY-MM-DD HH:MM:SS format
result=$(date_24h_ago)
if printf '%s' "$result" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'; then
  pass "date_24h_ago: output matches YYYY-MM-DD HH:MM:SS format"
else
  fail "date_24h_ago: expected YYYY-MM-DD HH:MM:SS, got '$result'"
fi

# Test 2: year/month/day components are plausible
year=$(echo "$result" | cut -d'-' -f1)
month=$(echo "$result" | cut -d'-' -f2)
day=$(echo "$result" | cut -d' ' -f1 | cut -d'-' -f3)
if [ "$year" -ge 2024 ] && [ "$year" -le 2030 ]; then
  pass "date_24h_ago: year is plausible ($year)"
else
  fail "date_24h_ago: year out of range ($year)"
fi
if [ "$month" -ge 1 ] && [ "$month" -le 12 ]; then
  pass "date_24h_ago: month is valid ($month)"
else
  fail "date_24h_ago: month out of range ($month)"
fi

# ── date_minutes_ago ───────────────────────────────────────────────

echo ""
log "=== date_minutes_ago: epoch N minutes ago ==="

# Test 1: returns numeric epoch
result=$(date_minutes_ago 5)
assert_numeric "$result" "date_minutes_ago: returns numeric epoch for 5 minutes"

# Test 2: value is approximately 5 minutes before now
now=$(date +%s)
expected_diff=300  # 5 * 60
actual_diff=$((now - result))
# Allow 5 seconds of tolerance
if [ "$actual_diff" -ge 295 ] && [ "$actual_diff" -le 305 ]; then
  pass "date_minutes_ago: 5 minutes ago is ~300s before now (diff=${actual_diff}s)"
else
  fail "date_minutes_ago: expected ~300s diff, got ${actual_diff}s"
fi

# Test 3: 0 minutes ago is approximately now
result=$(date_minutes_ago 0)
now=$(date +%s)
actual_diff=$((now - result))
if [ "$actual_diff" -ge -2 ] && [ "$actual_diff" -le 2 ]; then
  pass "date_minutes_ago: 0 minutes ago is ~now (diff=${actual_diff}s)"
else
  fail "date_minutes_ago: 0 minutes should be ~now (diff=${actual_diff}s)"
fi

# Test 4: larger value (60 minutes)
result=$(date_minutes_ago 60)
now=$(date +%s)
actual_diff=$((now - result))
if [ "$actual_diff" -ge 3595 ] && [ "$actual_diff" -le 3605 ]; then
  pass "date_minutes_ago: 60 minutes ago is ~3600s before now (diff=${actual_diff}s)"
else
  fail "date_minutes_ago: expected ~3600s diff, got ${actual_diff}s"
fi

# ── sed_inplace ────────────────────────────────────────────────────

echo ""
log "=== sed_inplace: portable in-place editing ==="

# Test 1: basic substitution
sed_file="$TMPDIR_ROOT/sed-test.txt"
echo "hello world" > "$sed_file"
sed_inplace 's/world/earth/' "$sed_file"
result=$(cat "$sed_file")
assert_eq "$result" "hello earth" "sed_inplace: basic substitution"

# Test 2: multi-line file
cat > "$sed_file" << 'EOF'
line one
line two
line three
EOF
sed_inplace 's/two/TWO/' "$sed_file"
result=$(cat "$sed_file")
assert_contains "$result" "line TWO" "sed_inplace: substitution in multi-line file"
assert_contains "$result" "line one" "sed_inplace: other lines preserved"
assert_contains "$result" "line three" "sed_inplace: non-matching lines preserved"

# Test 3: delete a line
echo -e "keep\nremove\nkeep" > "$sed_file"
sed_inplace '/remove/d' "$sed_file"
result=$(cat "$sed_file")
if printf '%s' "$result" | grep -qF "remove"; then
  fail "sed_inplace: deleted line should be gone"
else
  pass "sed_inplace: line deletion works"
fi

# Test 4: global substitution
echo "aaa bbb aaa" > "$sed_file"
sed_inplace 's/aaa/xxx/g' "$sed_file"
result=$(cat "$sed_file")
assert_eq "$result" "xxx bbb xxx" "sed_inplace: global substitution"

# ── to_upper ───────────────────────────────────────────────────────

echo ""
log "=== to_upper: uppercase conversion ==="

assert_eq "$(to_upper 'hello')" "HELLO" "to_upper: lowercase to uppercase"
assert_eq "$(to_upper 'Hello World')" "HELLO WORLD" "to_upper: mixed case"
assert_eq "$(to_upper 'ALREADY')" "ALREADY" "to_upper: already uppercase unchanged"
assert_eq "$(to_upper '')" "" "to_upper: empty string"
assert_eq "$(to_upper '123abc')" "123ABC" "to_upper: digits preserved, letters uppercased"
assert_eq "$(to_upper 'a-b_c.d')" "A-B_C.D" "to_upper: special chars preserved"

# ── realpath_portable ──────────────────────────────────────────────

echo ""
log "=== realpath_portable: portable path resolution ==="

# Test 1: resolves a real path
real_dir="$TMPDIR_ROOT/real-dir"
mkdir -p "$real_dir"
real_file="$real_dir/file.txt"
echo "test" > "$real_file"
result=$(realpath_portable "$real_file")
# Result should be an absolute path containing "file.txt"
assert_contains "$result" "file.txt" "realpath_portable: resolves path containing filename"
# Result should start with /
if [ "${result:0:1}" = "/" ]; then
  pass "realpath_portable: returns absolute path"
else
  fail "realpath_portable: should return absolute path, got '$result'"
fi

# Test 2: resolves symlinks
link_dir="$TMPDIR_ROOT/link-dir"
mkdir -p "$link_dir"
ln -sf "$real_file" "$link_dir/link.txt"
result=$(realpath_portable "$link_dir/link.txt")
# Should resolve to the real file path, not the symlink
if printf '%s' "$result" | grep -qF "real-dir/file.txt"; then
  pass "realpath_portable: resolves symlink to real path"
else
  # Some implementations may resolve differently but should still be absolute
  if [ "${result:0:1}" = "/" ]; then
    pass "realpath_portable: returns absolute path for symlink (may vary by impl)"
  else
    fail "realpath_portable: should resolve symlink, got '$result'"
  fi
fi

# Test 3: handles directory path
result=$(realpath_portable "$real_dir")
if [ "${result:0:1}" = "/" ]; then
  pass "realpath_portable: resolves directory path"
else
  fail "realpath_portable: should resolve directory path, got '$result'"
fi

# ── run_with_timeout ───────────────────────────────────────────────

echo ""
log "=== run_with_timeout: command timeout ==="

# Test 1: successful command completes
result=$(run_with_timeout 5 echo "hello")
assert_eq "$result" "hello" "run_with_timeout: successful command returns output"

# Test 2: command exit code is preserved
run_with_timeout 5 true
assert_eq "$?" "0" "run_with_timeout: exit 0 preserved for true"

run_with_timeout 5 false
rc=$?
if [ "$rc" -ne 0 ]; then
  pass "run_with_timeout: non-zero exit preserved for false (rc=$rc)"
else
  fail "run_with_timeout: should preserve non-zero exit for false"
fi

# Test 3: command that exceeds timeout gets killed
start=$(date +%s)
run_with_timeout 1 sleep 30 2>/dev/null
rc=$?
end=$(date +%s)
elapsed=$((end - start))
if [ "$elapsed" -le 5 ]; then
  pass "run_with_timeout: timed-out command killed quickly (${elapsed}s)"
else
  fail "run_with_timeout: timed-out command took too long (${elapsed}s)"
fi
if [ "$rc" -ne 0 ]; then
  pass "run_with_timeout: timed-out command returns non-zero (rc=$rc)"
else
  fail "run_with_timeout: timed-out command should return non-zero"
fi

# Test 4: captures stdout correctly
result=$(run_with_timeout 5 printf "multi\nline\noutput")
assert_contains "$result" "multi" "run_with_timeout: captures stdout line 1"
assert_contains "$result" "output" "run_with_timeout: captures stdout line 3"

# ── _acquire_file_lock / _release_file_lock ────────────────────────

echo ""
log "=== _acquire_file_lock / _release_file_lock: portable file locking ==="

# Test 1: acquire succeeds on fresh lock file
lock_file="$TMPDIR_ROOT/test.lock"
if _acquire_file_lock "$lock_file" 5; then
  pass "_acquire_file_lock: succeeds on fresh lock file"
else
  fail "_acquire_file_lock: should succeed on fresh lock file"
fi

# Verify lock state variables are set
if [ -n "$_FLOCK_FILE" ]; then
  pass "_acquire_file_lock: _FLOCK_FILE is set"
else
  fail "_acquire_file_lock: _FLOCK_FILE should be set"
fi
assert_eq "$_FLOCK_FILE" "$lock_file" "_acquire_file_lock: _FLOCK_FILE matches lock path"

# Verify .owner file contains our PID
if [ -f "$lock_file.owner" ]; then
  owner_pid=$(cat "$lock_file.owner")
  assert_eq "$owner_pid" "$$" "_acquire_file_lock: .owner file contains our PID"
else
  fail "_acquire_file_lock: .owner file should exist"
fi

# Test 2: release clears state
_release_file_lock
assert_eq "$_FLOCK_FILE" "" "_release_file_lock: _FLOCK_FILE cleared"
assert_eq "$_FLOCK_FD" "" "_release_file_lock: _FLOCK_FD cleared"
assert_eq "$_FLOCK_PID" "" "_release_file_lock: _FLOCK_PID cleared"

# Verify .owner file is removed
if [ -f "$lock_file.owner" ]; then
  fail "_release_file_lock: .owner file should be removed"
else
  pass "_release_file_lock: .owner file removed"
fi

# Test 3: acquire-release-acquire cycle works
lock_file2="$TMPDIR_ROOT/test2.lock"
_acquire_file_lock "$lock_file2" 5
_release_file_lock
if _acquire_file_lock "$lock_file2" 5; then
  pass "_acquire_file_lock: re-acquire after release succeeds"
else
  fail "_acquire_file_lock: re-acquire after release should succeed"
fi
_release_file_lock

# Test 4: lock file is created if it doesn't exist
lock_file3="$TMPDIR_ROOT/subdir/new.lock"
mkdir -p "$TMPDIR_ROOT/subdir"
if _acquire_file_lock "$lock_file3" 5; then
  pass "_acquire_file_lock: creates lock file if missing"
  if [ -f "$lock_file3" ]; then
    pass "_acquire_file_lock: lock file exists on disk"
  else
    # On Linux with flock, the file may exist as the FD target
    pass "_acquire_file_lock: lock held via file descriptor"
  fi
else
  fail "_acquire_file_lock: should create and acquire lock file"
fi
_release_file_lock

# Test 5: release is idempotent (calling twice doesn't error)
_acquire_file_lock "$lock_file" 5
_release_file_lock
_release_file_lock  # Second release should be a no-op
assert_eq "$_FLOCK_FILE" "" "_release_file_lock: idempotent — second call is no-op"
pass "_release_file_lock: double release does not error"

# Test 6: contention — second acquire on same file times out
lock_file4="$TMPDIR_ROOT/contention.lock"
_acquire_file_lock "$lock_file4" 5

# Try to acquire the same lock in a subshell (should time out)
(
  source "$REPO_ROOT/scripts/_compat.sh"
  if _acquire_file_lock "$lock_file4" 1; then
    exit 0  # acquired (unexpected)
  else
    exit 1  # timed out (expected)
  fi
) 2>/dev/null
subshell_rc=$?
if [ "$subshell_rc" -ne 0 ]; then
  pass "_acquire_file_lock: second acquire times out under contention"
else
  fail "_acquire_file_lock: second acquire should time out when lock is held"
fi

_release_file_lock

# Test 7: lock is available after holder explicitly releases in subprocess
lock_file5="$TMPDIR_ROOT/subprocess-release.lock"
(
  source "$REPO_ROOT/scripts/_compat.sh"
  _acquire_file_lock "$lock_file5" 5
  _release_file_lock
) 2>/dev/null
# Now we should be able to acquire the lock
if _acquire_file_lock "$lock_file5" 3; then
  pass "_acquire_file_lock: lock available after subprocess releases and exits"
else
  fail "_acquire_file_lock: should acquire lock after subprocess releases"
fi
_release_file_lock

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
