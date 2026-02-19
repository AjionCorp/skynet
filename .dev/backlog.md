# Backlog

<!-- Priority: top = highest. Format: - [ ] [TAG] Task title — description -->
<!-- Markers: [ ] = pending, [>] = claimed by worker, [x] = done -->

- [ ] [TEST] Add unit tests for shell script lock acquisition and task claiming — test PID lock, mkdir mutex, stale detection, and concurrent worker scenarios
- [ ] [TEST] Add TypeScript tests for API handlers — test pipeline-status, tasks POST, prompts extraction, monitoring-agents response shapes
- [ ] [FEAT] Add mission progress tracking to project-driver — parse mission.md success criteria, track completion percentage, report in dashboard
- [ ] [FEAT] Add mission.md viewer tab to admin dashboard — display the current mission with progress indicators next to each success criterion
- [ ] [INFRA] Add CI/CD workflow — GitHub Actions for typecheck, Playwright e2e, and shell script linting on every PR
- [ ] [FEAT] Add webhook notification support — Slack and Discord channels alongside Telegram via pluggable _notify.sh
- [ ] [FEAT] Add crash recovery to watchdog — detect zombie lock files, recover from partial task states, restart failed workers
- [ ] [INFRA] Add cron support alongside launchd — generate crontab entries for Linux systems in setup-agents
- [ ] [FEAT] Add task dependency tracking — allow tasks to declare blockedBy relationships in backlog.md syntax
- [ ] [TEST] Add Playwright tests for all dashboard component interactions — expand/collapse, tab switching, trigger buttons, log viewer
