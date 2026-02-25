#!/usr/bin/env bash
# echo.sh — Echo agent plugin for Skynet (dry-run / pipeline testing)
#
# Standard agent plugin interface:
#   agent_check              — returns 0 (always available, no LLM required)
#   agent_run "prompt" "log" — simulates full agent lifecycle phases and creates
#                              a placeholder commit echoing the task
#
# Usage: SKYNET_AGENT_PLUGIN=echo skynet start
# Tests the full pipeline lifecycle (claim, branch, gate, merge) without
# burning LLM API tokens.
#
# Configuration:
#   SKYNET_ECHO_FAIL=1        — simulate agent failure (exit 1)
#   SKYNET_ECHO_DELAY=N       — sleep N seconds to simulate work time

agent_check() {
  # Always available — no external dependencies
  return 0
}

agent_run() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"

  # Helper: timestamped log line
  _echo_log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] echo-agent: $*" >> "$log_file"; }

  _echo_log "=== DRY-RUN LIFECYCLE START ==="

  # --- Phase 1: Parse prompt ---
  # Real agents receive a structured prompt with "Your task: <title>".
  # Extract the task title for meaningful filenames and commit messages.
  local task_title=""
  task_title=$(printf '%s' "$prompt" | grep -m1 '^Your task: ' | sed 's/^Your task: //')
  if [ -z "$task_title" ]; then
    # Fallback: use the raw prompt (handles direct calls in tests)
    task_title="$prompt"
  fi
  _echo_log "phase=parse-prompt task='$(printf '%s' "$task_title" | head -c 80)'"

  # --- Phase 2: Validate preconditions ---
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    _echo_log "phase=validate FAILED — not inside a git work tree"
    _echo_log "=== DRY-RUN LIFECYCLE FAILED ==="
    return 1
  fi
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  _echo_log "phase=validate OK branch=$branch"

  # --- Phase 3: Simulate failure (for pipeline testing) ---
  if [ "${SKYNET_ECHO_FAIL:-0}" = "1" ]; then
    _echo_log "phase=simulate FAILURE (SKYNET_ECHO_FAIL=1)"
    _echo_log "=== DRY-RUN LIFECYCLE ABORTED ==="
    return 1
  fi

  # --- Phase 4: Simulate work ---
  _echo_log "phase=read-codebase skipped (dry-run)"
  _echo_log "phase=plan-implementation skipped (dry-run)"

  if [ "${SKYNET_ECHO_DELAY:-0}" -gt 0 ] 2>/dev/null; then
    _echo_log "phase=implement simulating work (${SKYNET_ECHO_DELAY}s delay)..."
    sleep "$SKYNET_ECHO_DELAY"
  fi

  # --- Phase 5: Create placeholder file ---
  local slug
  slug=$(printf '%s' "$task_title" | head -c 40 | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]' '-' | sed 's/^-//;s/-$//')
  local placeholder="echo-agent-${slug:-task}.md"

  {
    echo "# Echo Agent — Dry Run Placeholder"
    echo ""
    echo "**Task:** $task_title"
    echo "**Agent:** echo (dry-run)"
    echo "**Branch:** $branch"
    echo "**Timestamp:** $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""
    echo "## Task Description"
    echo ""
    echo "$prompt"
  } > "$placeholder"
  _echo_log "phase=implement created $placeholder"

  # --- Phase 6: Quality check (simulated) ---
  _echo_log "phase=quality-check skipped (dry-run — gates run by pipeline)"

  # --- Phase 7: Stage and commit ---
  git add "$placeholder" >> "$log_file" 2>&1
  git commit -m "echo-agent: dry-run placeholder for ${slug:-task}" >> "$log_file" 2>&1
  local rc=$?

  if [ "$rc" -ne 0 ]; then
    _echo_log "phase=commit FAILED (git exit $rc)"
    _echo_log "=== DRY-RUN LIFECYCLE FAILED ==="
    return $rc
  fi

  _echo_log "phase=commit OK"
  _echo_log "=== DRY-RUN LIFECYCLE COMPLETE ==="
  return 0
}
