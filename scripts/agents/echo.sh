#!/usr/bin/env bash
# echo.sh — Echo agent plugin for Skynet (dry-run / pipeline testing)
#
# Standard agent plugin interface:
#   agent_check              — returns 0 (always available, no LLM required)
#   agent_run "prompt" "log" — creates a placeholder commit echoing the task
#
# Usage: SKYNET_AGENT_PLUGIN=echo skynet start
# Tests the full pipeline lifecycle (claim, branch, gate, merge) without
# burning LLM API tokens.

agent_check() {
  # Always available — no external dependencies
  return 0
}

agent_run() {
  local prompt="$1"
  local log_file="${2:-/dev/null}"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] echo-agent: starting dry-run" >> "$log_file"

  # Extract a short filename from the prompt (first 40 chars, slugified)
  local slug
  slug=$(printf '%s' "$prompt" | head -c 40 | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]' '-' | sed 's/^-//;s/-$//')
  local placeholder="echo-agent-${slug:-task}.md"

  # Write placeholder file with task description
  {
    echo "# Echo Agent — Dry Run Placeholder"
    echo ""
    echo "TODO: implement"
    echo ""
    echo "## Task Description"
    echo ""
    echo "$prompt"
  } > "$placeholder"

  # Stage and commit
  git add "$placeholder" >> "$log_file" 2>&1
  git commit -m "echo-agent: dry-run placeholder for ${slug:-task}" >> "$log_file" 2>&1
  local rc=$?

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] echo-agent: finished (exit $rc)" >> "$log_file"
  return $rc
}
