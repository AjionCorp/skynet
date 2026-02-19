# Completed Tasks

| Date | Task | Branch | Notes |
|------|------|--------|-------|
| 2026-02-19 | [INFRA] Add cron support alongside launchd — detect OS in packages/cli/src/commands/setup-agents.ts, generate crontab entries for Linux systems (watchdog every 3min, health-check daily, auth-refresh hourly), add `--cron` flag | merged to main | success |
| 2026-02-19 | [FEAT] Add task dependency tracking — extend backlog.md syntax to support `blockedBy: task-title` metadata, update claim_next_task() in dev-worker.sh to skip tasks whose dependencies are not yet completed, add dependency visualization to dashboard tasks page | merged to main | success |
| 2026-02-19 | [FEAT] Add `skynet start` and `skynet stop` CLI commands — in packages/cli/src/commands/, `start` launches watchdog.sh as a background process (or loads launchd agents if installed), `stop` kills running workers gracefully via their PID lock files, register both in packages/cli/src/index.ts | merged to main | fixed (attempt 1) |
| 2026-02-19 | [FEAT] Add real-time pipeline dashboard via Server-Sent Events — create /api/admin/pipeline/stream route that watches .dev/ files for changes using fs.watch and streams status updates, update packages/admin/src/app/admin/pipeline/page.tsx to consume SSE instead of polling | merged to main | success |
