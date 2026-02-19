# Backlog

<!-- Priority: top = highest. Format: - [ ] [TAG] Task title — description -->
<!-- Markers: [ ] = pending, [>] = claimed by worker, [x] = done -->

- [x] [FEAT] Add crash recovery to watchdog — detect zombie lock files older than SKYNET_STALE_MINUTES, recover from partial task states (unclaim stuck tasks in backlog.md), kill orphan worktree processes, and restart failed workers automatically _(playwright failed)_
- [x] [FEAT] Add `skynet start` and `skynet stop` CLI commands — in packages/cli/src/commands/, `start` launches watchdog.sh as a background process (or loads launchd agents if installed), `stop` kills running workers gracefully via their PID lock files, register both in packages/cli/src/index.ts _(playwright failed)_
- [x] [INFRA] Add npm package build and publish workflow — add prepublishOnly script to packages/cli/package.json, verify bin field points to compiled output, add GitHub Actions workflow to publish to npm on version tag, test that `npx skynet init` works end-to-end _(playwright failed)_
- [x] [FEAT] Add self-correction metrics tracking — create .dev/metrics.md with auto-fix success rate, track in task-fixer.sh how many failures get auto-resolved vs blocked, expose metrics via new /api/admin/metrics route in packages/admin/src/app/api/admin/metrics/route.ts _(playwright failed)_
- [x] [TEST] Add unit tests for shell script lock acquisition and task claiming — test PID lock, mkdir mutex, stale detection, and concurrent worker scenarios _(playwright failed)_
- [x] [TEST] Add TypeScript tests for API handlers — test pipeline-status, tasks POST, prompts extraction, monitoring-agents response shapes _(playwright failed)_
- [x] [FEAT] Add mission progress tracking to project-driver — parse mission.md success criteria, track completion percentage, report in dashboard _(playwright failed)_
- [x] [FEAT] Add mission.md viewer tab to admin dashboard — display the current mission with progress indicators next to each success criterion _(playwright failed)_
- [x] [INFRA] Add CI/CD workflow — GitHub Actions for typecheck, Playwright e2e, and shell script linting on every PR _(playwright failed)_
- [x] [FEAT] Add webhook notification support — Slack and Discord channels alongside Telegram via pluggable _notify.sh _(playwright failed)_
- [x] [INFRA] Add cron support alongside launchd — detect OS in packages/cli/src/commands/setup-agents.ts, generate crontab entries for Linux systems (watchdog every 3min, health-check daily, auth-refresh hourly), add `--cron` flag
- [>] [FEAT] Add task dependency tracking — extend backlog.md syntax to support `blockedBy: task-title` metadata, update claim_next_task() in dev-worker.sh to skip tasks whose dependencies are not yet completed, add dependency visualization to dashboard tasks page
- [ ] [FEAT] Add real-time pipeline dashboard via Server-Sent Events — create /api/admin/pipeline/stream route that watches .dev/ files for changes using fs.watch and streams status updates, update packages/admin/src/app/admin/pipeline/page.tsx to consume SSE instead of polling
- [ ] [TEST] Add Playwright tests for all dashboard component interactions — expand/collapse, tab switching, trigger buttons, log viewer, mission viewer tab, metrics display
