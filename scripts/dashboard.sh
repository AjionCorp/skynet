#!/usr/bin/env bash
# dashboard.sh — TUI status dashboard for Skynet CI/CD pipeline
# Usage: bash dashboard.sh [--once] [--interval N]
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_config.sh"

# --- Args ---
ONCE=false
INTERVAL=2
while [ $# -gt 0 ]; do
  case "$1" in
    --once) ONCE=true; shift ;;
    --interval) shift; INTERVAL="${1:-2}"; shift ;;
    *) shift ;;
  esac
done

# --- Colors ---
RESET=$(tput sgr0)
BOLD=$(tput bold)
DIM=$(tput dim)
RED=$(tput setaf 1)
GREEN=$(tput setaf 2)
YELLOW=$(tput setaf 3)
CYAN=$(tput setaf 6)
WHITE=$(tput setaf 7)
GRAY=$(tput setaf 8)

# --- Box chars ---
W=70

hline() {
  local left="$1" right="$2"
  printf "${CYAN}%s" "$left"
  printf '%0.s─' $(seq 1 $((W-2)))
  printf "%s${RESET}\n" "$right"
}

hline_split() {
  local left="$1" mid="$2" right="$3" col="$4"
  printf "${CYAN}%s" "$left"
  printf '%0.s─' $(seq 1 $((col-1)))
  printf "%s" "$mid"
  printf '%0.s─' $(seq 1 $((W-col-2)))
  printf "%s${RESET}\n" "$right"
}

# Print a line padded to width W inside box borders
row() {
  local text="$1"
  # Strip ANSI for length calculation
  local stripped
  stripped=$(printf '%s' "$text" | sed $'s/\x1b\[[0-9;]*m//g')
  local len=${#stripped}
  local pad=$((W - 3 - len))
  [ "$pad" -lt 0 ] && pad=0
  printf "${CYAN}│${RESET} %s%*s${CYAN}│${RESET}\n" "$text" "$pad" ""
}

# Print two columns side by side
row2() {
  local left="$1" right="$2" col="$3"
  local ls rs
  ls=$(printf '%s' "$left" | sed $'s/\x1b\[[0-9;]*m//g')
  rs=$(printf '%s' "$right" | sed $'s/\x1b\[[0-9;]*m//g')
  local lpad=$((col - 2 - ${#ls}))
  local rpad=$((W - col - 3 - ${#rs}))
  [ "$lpad" -lt 0 ] && lpad=0
  [ "$rpad" -lt 0 ] && rpad=0
  printf "${CYAN}│${RESET} %s%*s${CYAN}│${RESET} %s%*s${CYAN}│${RESET}\n" "$left" "$lpad" "" "$right" "$rpad" ""
}

trunc() {
  local t="$1" m="$2"
  [ ${#t} -gt "$m" ] && t="${t:0:$((m-1))}~"
  printf '%s' "$t"
}

reltime() {
  local s="$1"
  if [ "$s" -lt 60 ]; then echo "${s}s"
  elif [ "$s" -lt 3600 ]; then echo "$((s/60))m"
  elif [ "$s" -lt 86400 ]; then echo "$((s/3600))h"
  else echo "$((s/86400))d"
  fi
}

is_running() {
  local lf="$1"
  [ -f "$lf" ] && kill -0 "$(cat "$lf" 2>/dev/null)" 2>/dev/null
}

safe_count() {
  # grep -c returns exit 1 when count=0; capture just the number
  local result
  result=$(grep -c "$@" 2>/dev/null) || true
  echo "${result:-0}" | head -1 | tr -d '[:space:]'
}

next_fire() {
  local pat="$1"
  local h m
  h=$(date +%H | sed 's/^0*//' | sed 's/^$/0/')
  m=$(date +%M | sed 's/^0*//' | sed 's/^$/0/')

  case "$pat" in
    "*/3")   local n=$(((m/3+1)*3)); [ "$n" -ge 60 ] && printf "%02d:00" $(((h+1)%24)) || printf "%02d:%02d" "$h" "$n" ;;
    "*/15")  local n=$(((m/15+1)*15)); [ "$n" -ge 60 ] && printf "%02d:00" $(((h+1)%24)) || printf "%02d:%02d" "$h" "$n" ;;
    "5,35")  [ "$m" -lt 5 ] && printf "%02d:05" "$h" || { [ "$m" -lt 35 ] && printf "%02d:35" "$h" || printf "%02d:05" $(((h+1)%24)); } ;;
    "10")    [ "$m" -lt 10 ] && printf "%02d:10" "$h" || printf "%02d:10" $(((h+1)%24)) ;;
    "40e2")  [ $((h%2)) -eq 0 ] && [ "$m" -lt 40 ] && printf "%02d:40" "$h" || printf "%02d:40" $(((h/2+1)*2%24)) ;;
    "6h")    printf "%02d:00" $(((h/6+1)*6%24)) ;;
    "8am")   [ "$h" -lt 8 ] && echo "08:00" || echo "08:00+1d" ;;
    "8,20")  [ "$h" -lt 8 ] && echo "08:00" || { [ "$h" -lt 20 ] && echo "20:00" || echo "08:00+1d"; } ;;
  esac
}

# --- Render ---
render() {
  local now now_epoch
  now=$(date '+%Y-%m-%d %H:%M:%S %Z')
  now_epoch=$(date +%s)

  # Header
  hline "┌" "┐"
  row "${BOLD}${WHITE}          $SKYNET_PROJECT_NAME_UPPER PIPELINE DASHBOARD${RESET}"
  row "${DIM}          $now${RESET}"
  hline "├" "┤"

  # Workers
  row "${BOLD}${YELLOW} WORKERS${RESET}"

  local workers=("dev-worker" "task-fixer" "project-driver" "sync-runner" "ui-tester" "feature-validator" "health-check")
  local labels=("dev-worker" "task-fixer" "project-driver" "sync-runner" "ui-tester" "feature-valid." "health-check")
  local scheds=("every 15m" "every 30m" "8am + 8pm" "every 6h" "every 1h" "every 2h" "daily 8am")

  for i in "${!workers[@]}"; do
    local w="${workers[$i]}" lbl="${labels[$i]}" sch="${scheds[$i]}"
    local lock="${SKYNET_LOCK_PREFIX}-${w}.lock"
    if is_running "$lock"; then
      local pid age age_s
      pid=$(cat "$lock" 2>/dev/null)
      age=$((now_epoch - $(file_mtime "$lock")))
      age_s=$(reltime "$age")
      row "  ${GREEN}●${RESET} ${BOLD}$(printf '%-17s' "$lbl")${RESET} ${GREEN}RUNNING${RESET}  PID ${DIM}$pid${RESET}  ${DIM}(${age_s})${RESET}"
    else
      local last=""
      [ -f "$SCRIPTS_DIR/${w}.log" ] && last=$(tail -1 "$SCRIPTS_DIR/${w}.log" 2>/dev/null | grep -o '\[.*\]' | head -1 || true)
      if [ -n "$last" ]; then
        row "  ${GRAY}○${RESET} ${DIM}$(printf '%-17s' "$lbl") idle  $sch  $last${RESET}"
      else
        row "  ${GRAY}○${RESET} ${DIM}$(printf '%-17s' "$lbl") idle  $sch${RESET}"
      fi
    fi
  done
  row "  ${CYAN}⟳${RESET} $(printf '%-17s' "watchdog") ${DIM}every 3m${RESET}"

  hline "├" "┤"

  # Current Task
  row "${BOLD}${YELLOW} CURRENT TASK${RESET}"
  local status
  status=$(grep "Status:" "$CURRENT_TASK" 2>/dev/null | head -1 | sed 's/.*Status:\*\* //' || echo "unknown")

  if [ "$status" = "idle" ]; then
    row "  ${DIM}Idle${RESET}"
    local lastinfo
    lastinfo=$(grep "Last" "$CURRENT_TASK" 2>/dev/null | head -1 | sed 's/\*\*.*:\*\* //' || true)
    [ -n "$lastinfo" ] && row "  ${DIM}$(trunc "$lastinfo" 63)${RESET}"
  elif [ "$status" = "in_progress" ]; then
    local tname branch started
    tname=$(grep "^##" "$CURRENT_TASK" 2>/dev/null | head -1 | sed 's/^## //' || echo "Unknown")
    branch=$(grep "Branch:" "$CURRENT_TASK" 2>/dev/null | head -1 | sed 's/.*Branch:\*\* //' || true)
    started=$(grep "Started:" "$CURRENT_TASK" 2>/dev/null | head -1 | sed 's/.*Started:\*\* //' || true)
    row "  ${GREEN}${BOLD}$(trunc "$tname" 63)${RESET}"
    [ -n "$branch" ] && row "  ${DIM}Branch: $branch${RESET}"
    [ -n "$started" ] && row "  ${DIM}Started: $started${RESET}"
  else
    local tname
    tname=$(grep "^##" "$CURRENT_TASK" 2>/dev/null | head -1 | sed 's/^## //' || echo "")
    row "  ${CYAN}$status${RESET} ${DIM}$(trunc "$tname" 50)${RESET}"
  fi

  local SP=35
  hline_split "├" "┬" "┤" "$SP"

  # Backlog + Sync Health side by side
  local bl_count
  bl_count=$(safe_count '^\- \[ \]' "$BACKLOG")

  row2 "${BOLD}${YELLOW}BACKLOG${RESET} ${DIM}($bl_count pending)${RESET}" "${BOLD}${YELLOW}SYNC HEALTH${RESET}" "$SP"

  # Build backlog items (max 5)
  local -a BL=()
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local tag name
    tag=$(echo "$line" | grep -o '^\[.*\]' || true)
    name=$(echo "$line" | sed 's/^\[.*\] //' | sed 's/ — .*//')
    BL+=("${CYAN}$tag${RESET} $(trunc "$name" 22)")
  done < <(grep '^\- \[ \]' "$BACKLOG" 2>/dev/null | head -5 | sed 's/^- \[ \] //')

  # Build sync health items (max 7)
  local -a SH=()
  while IFS='|' read -r _ ep _ st _ notes _; do
    ep=$(echo "$ep" | xargs)
    st=$(echo "$st" | xargs)
    notes=$(echo "$notes" | xargs)
    [ -z "$ep" ] && continue
    local icon
    case "$st" in
      ok) icon="${GREEN}✓${RESET}" ;;
      error) icon="${RED}✗${RESET}" ;;
      *) icon="${YELLOW}◌${RESET}" ;;
    esac
    SH+=("$icon $(printf '%-13s' "$ep") $(trunc "$notes" 16)")
  done < <(grep '^|' "$SYNC_HEALTH" 2>/dev/null | grep -v 'Endpoint\|---' | head -10)

  # Render side by side
  local max=${#BL[@]}
  [ ${#SH[@]} -gt "$max" ] && max=${#SH[@]}
  [ "$max" -lt 1 ] && max=1

  for ((i=0; i<max; i++)); do
    row2 "${BL[$i]:-}" "${SH[$i]:-}" "$SP"
  done

  hline_split "├" "┴" "┤" "$SP"

  # Completed
  local comp_total
  comp_total=$(safe_count '^|.*|.*|.*|' "$COMPLETED")
  comp_total=$((comp_total > 2 ? comp_total - 2 : 0))

  row "${BOLD}${YELLOW} COMPLETED${RESET} ${DIM}($comp_total total, last 5)${RESET}"

  local comp_found=0
  while IFS='|' read -r _ date task _ notes _; do
    date=$(echo "$date" | xargs)
    task=$(echo "$task" | xargs)
    [ -z "$task" ] && continue
    local sd
    sd=$(echo "$date" | sed 's/20[0-9][0-9]-//')
    row "  ${GREEN}✓${RESET} $(printf '%-49s' "$(trunc "$task" 49)") ${DIM}$sd${RESET}"
    comp_found=$((comp_found + 1))
  done < <(grep '^|' "$COMPLETED" 2>/dev/null | grep -v 'Date\|---' | tail -5)

  [ "$comp_found" -eq 0 ] && row "  ${DIM}No completed tasks yet${RESET}"

  hline "├" "┤"

  # Failed + Blockers
  local fail_count
  fail_count=$(safe_count '| pending |' "$FAILED")
  local blocker_text
  if grep -q "No active blockers" "$BLOCKERS" 2>/dev/null; then
    blocker_text="${DIM}No active blockers${RESET}"
  else
    blocker_text="${RED}${BOLD}HAS BLOCKERS!${RESET}"
  fi

  row2 "${BOLD}${YELLOW}FAILED${RESET} ${DIM}($fail_count pending)${RESET}" "${BOLD}${YELLOW}BLOCKERS${RESET}" "$SP"

  local first=true
  while IFS='|' read -r _ _ task _ _ attempts _; do
    task=$(echo "$task" | xargs)
    attempts=$(echo "$attempts" | xargs)
    [ -z "$task" ] && continue
    local rc=""
    $first && rc="$blocker_text" && first=false
    row2 "${RED}✗${RESET} $(trunc "$task" 24) ${DIM}($attempts/3)${RESET}" "$rc" "$SP"
  done < <(grep '| pending |' "$FAILED" 2>/dev/null | head -3)

  $first && row2 "${DIM}None${RESET}" "$blocker_text" "$SP"

  hline "├" "┤"

  # Next Crons
  row "${BOLD}${YELLOW} NEXT CRONS${RESET}"
  local nw nd nf nu nv ns
  nw=$(next_fire "*/3"); nd=$(next_fire "*/15"); nf=$(next_fire "5,35")
  nu=$(next_fire "10"); nv=$(next_fire "40e2"); ns=$(next_fire "6h")
  row "  ${DIM}watchdog${RESET}  ${CYAN}$nw${RESET}  ${GRAY}│${RESET}  ${DIM}dev-worker${RESET}  ${CYAN}$nd${RESET}  ${GRAY}│${RESET}  ${DIM}task-fixer${RESET}  ${CYAN}$nf${RESET}"
  row "  ${DIM}ui-tester${RESET} ${CYAN}$nu${RESET}  ${GRAY}│${RESET}  ${DIM}feat-val.${RESET}  ${CYAN}$nv${RESET}  ${GRAY}│${RESET}  ${DIM}sync-run.${RESET}  ${CYAN}$ns${RESET}"

  hline "└" "┘"
}

# --- Main ---
cleanup() { tput cnorm 2>/dev/null; printf '\n'; exit 0; }
trap cleanup INT TERM

if $ONCE; then
  render
else
  tput civis 2>/dev/null
  while true; do
    tput cup 0 0 2>/dev/null || clear
    render
    sleep "$INTERVAL"
  done
fi
