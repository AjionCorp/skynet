#!/usr/bin/env bash
# _compat.sh — Cross-platform compatibility shims
# Sourced by _config.sh. Provides portable wrappers for macOS vs Linux differences.

# Detect platform
SKYNET_IS_MACOS=false
[ "$(uname -s)" = "Darwin" ] && SKYNET_IS_MACOS=true

# Portable file modification time (epoch seconds)
file_mtime() {
  if $SKYNET_IS_MACOS; then
    stat -f %m "$1" 2>/dev/null || echo 0
  else
    stat -c %Y "$1" 2>/dev/null || echo 0
  fi
}

# Portable file size in bytes
file_size() {
  if $SKYNET_IS_MACOS; then
    stat -f%z "$1" 2>/dev/null || echo 0
  else
    stat -c%s "$1" 2>/dev/null || echo 0
  fi
}

# Portable "24 hours ago" timestamp (YYYY-MM-DD HH:MM:SS)
date_24h_ago() {
  if $SKYNET_IS_MACOS; then
    date -v-24H '+%Y-%m-%d %H:%M:%S' 2>/dev/null
  else
    date -d '24 hours ago' '+%Y-%m-%d %H:%M:%S' 2>/dev/null
  fi
}

# Portable "N minutes ago" epoch
date_minutes_ago() {
  local mins="${1:-0}"
  if $SKYNET_IS_MACOS; then
    date -v-"${mins}"M +%s 2>/dev/null
  else
    date -d "${mins} minutes ago" +%s 2>/dev/null
  fi
}

# Portable sed in-place
sed_inplace() {
  if $SKYNET_IS_MACOS; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# Portable uppercase (bash 3.2 doesn't support ${VAR^^})
to_upper() {
  echo "$1" | tr '[:lower:]' '[:upper:]'
}

# Portable command timeout (macOS lacks GNU timeout)
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  elif command -v perl >/dev/null 2>&1; then
    # perl fallback — available on all macOS
    perl -e 'alarm shift; exec @ARGV' "$secs" "$@" 2>/dev/null
  else
    # No timeout mechanism available — run without timeout and warn
    echo "[WARN] run_with_timeout: no timeout/gtimeout/perl found, running without timeout" >&2
    "$@"
  fi
}

# Portable readlink -f (resolve symlinks)
realpath_portable() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1"
  elif $SKYNET_IS_MACOS; then
    python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$1" 2>/dev/null || echo "$1"
  else
    readlink -f "$1" 2>/dev/null || echo "$1"
  fi
}

# ============================================================
# PORTABLE FILE LOCKING (flock)
# ============================================================
# Linux: native flock(1) command (util-linux)
# macOS: perl Fcntl::flock fallback (perl ships with all macOS)
#
# Usage:
#   _acquire_file_lock "$lockfile" "$timeout_secs"  -> returns 0 on success, 1 on timeout
#   _release_file_lock                              -> releases current lock
#
# Auto-release on process death is guaranteed by the kernel on both platforms.
# Lock state is stored in module-level variables:
#   _FLOCK_FD   -- file descriptor (Linux)
#   _FLOCK_PID  -- perl helper PID (macOS)
#   _FLOCK_FILE -- the lock file path

_FLOCK_FD=""
_FLOCK_PID=""
_FLOCK_FILE=""

_acquire_file_lock() {
  local lockfile="$1"
  local timeout="${2:-30}"
  _FLOCK_FILE="$lockfile"

  # Create lock file if it doesn't exist
  touch "$lockfile" 2>/dev/null || true

  if ! $SKYNET_IS_MACOS; then
    # Linux: use native flock
    # Open file on FD 9 and use flock with timeout
    exec 9>"$lockfile"
    if flock -w "$timeout" 9 2>/dev/null; then
      _FLOCK_FD=9
      # Write PID for observability (not used for locking logic)
      echo $$ > "$lockfile.owner" 2>/dev/null || true
      return 0
    else
      exec 9>&- 2>/dev/null || true
      return 1
    fi
  else
    # macOS: use perl Fcntl as flock helper
    # The perl process holds the lock; killing it releases the lock.
    # We use a ready-pipe so we know when the lock is actually acquired.
    local _ready_pipe
    _ready_pipe=$(mktemp /tmp/skynet-flock-pipe-XXXXXX)
    rm -f "$_ready_pipe"
    # FIFO is cleaned up at rm -f below. If the process is killed between
    # mkfifo and rm, the orphaned FIFO in /tmp is harmless (cleaned on reboot).
    mkfifo "$_ready_pipe" 2>/dev/null || { rm -f "$_ready_pipe"; return 1; }

    perl -e '
      use Fcntl qw(:flock);
      my ($lockfile, $timeout, $ready_pipe) = @ARGV;
      open(my $fh, ">", $lockfile) or die "Cannot open $lockfile: $!";
      my $deadline = time() + $timeout;
      my $got_lock = 0;
      while (time() < $deadline) {
        if (flock($fh, LOCK_EX | LOCK_NB)) {
          $got_lock = 1;
          last;
        }
        select(undef, undef, undef, 0.1);  # sleep 100ms
      }
      if (!$got_lock) {
        open(my $rp, ">", $ready_pipe);
        print $rp "TIMEOUT\n";
        close($rp);
        exit 1;
      }
      # Signal that lock is acquired
      open(my $rp, ">", $ready_pipe);
      print $rp "LOCKED\n";
      close($rp);
      # Hold lock until killed (SIGTERM/SIGKILL releases the file lock)
      $SIG{TERM} = sub { exit 0; };
      $SIG{INT}  = sub { exit 0; };
      sleep 86400 while 1;  # Hold indefinitely until killed
    ' "$lockfile" "$timeout" "$_ready_pipe" &
    _FLOCK_PID=$!

    # Wait for ready signal (with timeout slightly longer than perl lock timeout
    # to avoid hanging forever if perl crashes before writing to the pipe)
    local _result
    _result=$(run_with_timeout "$((timeout + 5))" cat "$_ready_pipe" 2>/dev/null || echo "ERROR")
    rm -f "$_ready_pipe"

    if [ "$_result" = "LOCKED" ]; then
      echo $$ > "$lockfile.owner" 2>/dev/null || true
      return 0
    else
      # Timeout or error -- clean up
      kill "$_FLOCK_PID" 2>/dev/null || true
      wait "$_FLOCK_PID" 2>/dev/null || true
      _FLOCK_PID=""
      return 1
    fi
  fi
}

_release_file_lock() {
  if [ -n "$_FLOCK_FD" ]; then
    # Linux: close the file descriptor
    exec 9>&- 2>/dev/null || true
    _FLOCK_FD=""
  fi
  if [ -n "$_FLOCK_PID" ]; then
    # macOS: kill the perl helper
    kill "$_FLOCK_PID" 2>/dev/null || true
    wait "$_FLOCK_PID" 2>/dev/null || true
    _FLOCK_PID=""
  fi
  rm -f "${_FLOCK_FILE}.owner" 2>/dev/null || true
  _FLOCK_FILE=""
}
