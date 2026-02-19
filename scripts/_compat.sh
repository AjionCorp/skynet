#!/usr/bin/env bash
# _compat.sh — Cross-platform compatibility shims
# Sourced by _config.sh. Provides portable wrappers for macOS vs Linux differences.

# Detect platform
SKYNET_IS_MACOS=false
[[ "$(uname -s)" == "Darwin" ]] && SKYNET_IS_MACOS=true

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

# Portable readlink -f (resolve symlinks)
realpath_portable() {
  if command -v realpath &>/dev/null; then
    realpath "$1"
  elif $SKYNET_IS_MACOS; then
    python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$1" 2>/dev/null || echo "$1"
  else
    readlink -f "$1" 2>/dev/null || echo "$1"
  fi
}
