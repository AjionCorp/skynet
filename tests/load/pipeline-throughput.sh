#!/usr/bin/env bash
# tests/load/pipeline-throughput.sh — Measure pipeline throughput (tasks/minute)
#
# Usage: bash tests/load/pipeline-throughput.sh [N]
#   N = number of tasks to run (default: 20)
#
# Uses the echo agent (no LLM API calls) to measure raw pipeline overhead:
# claim, branch, gate, merge cycle time. Results printed to stdout.
#
# Prerequisites:
#   - A Skynet project initialized in the current directory
#   - pnpm install completed
#
# Example:
#   bash tests/load/pipeline-throughput.sh 10
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_COUNT="${1:-20}"
DEV_DIR="${SKYNET_DEV_DIR:-$REPO_ROOT/.dev}"
DB_PATH="$DEV_DIR/skynet.db"
SCRIPTS_DIR="$DEV_DIR/scripts"

# Validate environment
if [ ! -f "$DEV_DIR/skynet.config.sh" ]; then
  echo "ERROR: No Skynet project found at $REPO_ROOT" >&2
  echo "Run 'skynet init' first." >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 is required but not found." >&2
  exit 1
fi

# Source config for DB helpers
source "$SCRIPTS_DIR/_config.sh"

echo "=== Skynet Pipeline Throughput Test ==="
echo "Tasks:  $TASK_COUNT"
echo "Agent:  echo (dry-run, no LLM)"
echo ""

# Record initial completed count
initial_done=0
if [ -f "$DB_PATH" ]; then
  initial_done=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='done';" 2>/dev/null || echo 0)
fi

# Seed the backlog with N tasks
echo "Seeding $TASK_COUNT tasks into backlog..."
for i in $(seq 1 "$TASK_COUNT"); do
  db_add_task "Load-test task $i — throughput measurement" "FEAT" "" "bottom" "" 2>/dev/null
done

# Verify tasks were added
pending=$(db_count_pending 2>/dev/null || echo 0)
echo "Backlog pending: $pending"

# Start timer
start_epoch=$(date +%s)
echo ""
echo "Starting pipeline ($(date '+%Y-%m-%d %H:%M:%S'))..."

# Launch watchdog with echo agent — it will dispatch workers
export SKYNET_AGENT_PLUGIN=echo
export SKYNET_WATCHDOG_INTERVAL=5
SKYNET_DEV_DIR="$DEV_DIR" nohup bash "$SCRIPTS_DIR/watchdog.sh" > /dev/null 2>&1 &
watchdog_pid=$!

cleanup() {
  kill "$watchdog_pid" 2>/dev/null || true
  # Kill any workers it spawned
  for pidfile in /tmp/skynet-*-dev-worker-*.lock/pid; do
    [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null || true
  done
  rm -rf /tmp/skynet-*-watchdog.lock 2>/dev/null || true
}
trap cleanup EXIT

# Poll until all tasks are done or timeout (10 min)
timeout_secs=600
while true; do
  current_done=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE status='done';" 2>/dev/null || echo 0)
  completed=$((current_done - initial_done))
  elapsed=$(( $(date +%s) - start_epoch ))

  printf "\r  Completed: %d/%d  Elapsed: %ds   " "$completed" "$TASK_COUNT" "$elapsed"

  if [ "$completed" -ge "$TASK_COUNT" ]; then
    break
  fi
  if [ "$elapsed" -ge "$timeout_secs" ]; then
    echo ""
    echo "TIMEOUT: Only $completed/$TASK_COUNT tasks completed in ${timeout_secs}s"
    break
  fi
  sleep 2
done

end_epoch=$(date +%s)
total_secs=$((end_epoch - start_epoch))
total_secs=$((total_secs > 0 ? total_secs : 1))

echo ""
echo ""
echo "=== Results ==="
echo "Start:      $(date -r "$start_epoch" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d "@$start_epoch" '+%Y-%m-%d %H:%M:%S')"
echo "End:        $(date -r "$end_epoch" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -d "@$end_epoch" '+%Y-%m-%d %H:%M:%S')"
echo "Duration:   ${total_secs}s"
echo "Tasks:      $completed / $TASK_COUNT"
echo "Throughput: $(( completed * 60 / total_secs )) tasks/minute"
