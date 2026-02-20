# Current Task
## [INFRA] Add health score alert notification to watchdog — in `scripts/watchdog.sh`, after the crash recovery and stale detection phases, compute a simple health score using the same logic as the pipeline-status handler: start at 100, subtract 5 per pending failed task (grep `status=pending` in failed-tasks.md), subtract 10 per active blocker (count non-empty lines under `## Active` in blockers.md), subtract 2 per stale heartbeat. If score drops below `${SKYNET_HEALTH_ALERT_THRESHOLD:-50}`, call `emit_event "health_alert" "Health score: $score"` and `notify_all "Pipeline health alert: score $score/100"`. Use a sentinel file `.dev/health-alert-sent` to prevent repeated alerts — only alert once per drop, delete sentinel when score recovers above threshold. Add `SKYNET_HEALTH_ALERT_THRESHOLD="50"` to `templates/skynet.config.sh` with comment. Criterion #3 (proactive failure detection)
**Status:** completed
**Started:** 2026-02-20 00:35
**Completed:** 2026-02-20
**Branch:** dev/add-health-score-alert-notification-to-w
**Worker:** 2

### Changes
-- See git log for details
