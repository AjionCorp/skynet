#!/usr/bin/env bash
# _lock_backend.sh — Pluggable lock backend loader
# Sourced by _config.sh before _locks.sh.
# Backend plugins live in scripts/lock-backends/*.sh and define:
#   lock_backend_acquire "$name" "$timeout"
#   lock_backend_release "$name"
#   lock_backend_check "$name"

# Validate lock backend name: must be alphanumeric/underscore/hyphen only
if [ -n "${SKYNET_LOCK_BACKEND:-}" ]; then
  case "$SKYNET_LOCK_BACKEND" in
    *[!a-zA-Z0-9_-]*) echo "FATAL: SKYNET_LOCK_BACKEND contains unsafe characters: $SKYNET_LOCK_BACKEND" >&2; exit 1 ;;
  esac
fi

_lock_backend_file="${SKYNET_SCRIPTS_DIR}/lock-backends/${SKYNET_LOCK_BACKEND:-file}.sh"
if [ -f "$_lock_backend_file" ]; then
  # shellcheck source=/dev/null
  source "$_lock_backend_file"
else
  if [ "${SKYNET_LOCK_BACKEND:-file}" != "file" ]; then
    echo "WARNING: Lock backend '${SKYNET_LOCK_BACKEND}' not found — falling back to 'file'" >&2
  fi
  # shellcheck source=/dev/null
  source "${SKYNET_SCRIPTS_DIR}/lock-backends/file.sh"
fi
unset _lock_backend_file
