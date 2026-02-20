# Current Task
## [INFRA] Add events.log rotation to _events.sh to prevent unbounded growth — in `scripts/_events.sh`, modify `emit_event()` to check file size before appending. Add before the `echo >> "$events_log"` line: `local max_kb="${SKYNET_MAX_EVENTS_LOG_KB:-1024}"; if [ -f "$events_log" ]; then local sz; sz=$(wc -c < "$events_log" 2>/dev/null || echo 0); if [ "$sz" -gt $((max_kb * 1024)) ]; then mv "$events_log" "${events_log}.1"; fi; fi`. This mirrors the `rotate_log_if_needed()` pattern in `_config.sh`. Add `SKYNET_MAX_EVENTS_LOG_KB="1024"` to `templates/skynet.config.sh` with comment. events.log is the only log file without rotation. Criterion #3 (no unbounded resource consumption)
**Status:** completed
**Started:** 2026-02-19 23:15
**Completed:** 2026-02-19
**Branch:** dev/add-eventslog-rotation-to-eventssh-to-pr
**Worker:** 1

### Changes
-- See git log for details
