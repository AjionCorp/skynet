# Completed Tasks

| Date | Task | Branch | Notes |
|------|------|--------|-------|
| 2026-02-19 | [INFRA] Add cron support alongside launchd — detect OS in packages/cli/src/commands/setup-agents.ts, generate crontab entries for Linux systems (watchdog every 3min, health-check daily, auth-refresh hourly), add `--cron` flag | merged to main | success |
| 2026-02-19 | [FEAT] Add task dependency tracking — extend backlog.md syntax to support `blockedBy: task-title` metadata, update claim_next_task() in dev-worker.sh to skip tasks whose dependencies are not yet completed, add dependency visualization to dashboard tasks page | merged to main | success |
