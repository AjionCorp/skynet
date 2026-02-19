# Failed Tasks

| Date | Task | Branch | Error | Attempts | Status |
|------|------|--------|-------|----------|--------|
| 2026-02-19 | [FEAT] Add `skynet start` and `skynet stop` CLI commands — in packages/cli/src/commands/, `start` launches watchdog.sh as a background process (or loads launchd agents if installed), `stop` kills running workers gracefully via their PID lock files, register both in packages/cli/src/index.ts | merged to main | playwright tests failed | 1 | fixed |
| 2026-02-19 | [FEAT] Add crash recovery to watchdog — detect zombie lock files older than SKYNET_STALE_MINUTES, recover from partial task states (unclaim stuck tasks in backlog.md), kill orphan worktree processes, and restart failed workers automatically | merged to main | playwright tests failed (fix attempt 1 failed) | 2 | fixed |
| 2026-02-19 | [INFRA] Add npm package build and publish workflow — add prepublishOnly script to packages/cli/package.json, verify bin field points to compiled output, add GitHub Actions workflow to publish to npm on version tag, test that `npx skynet init` works end-to-end | merged to main | playwright tests failed | 1 | fixed |
| 2026-02-19 | [FEAT] Add self-correction metrics tracking — create .dev/metrics.md with auto-fix success rate, track in task-fixer.sh how many failures get auto-resolved vs blocked, expose metrics via new /api/admin/metrics route in packages/admin/src/app/api/admin/metrics/route.ts | dev/add-self-correction-metrics-tracking--cr | playwright tests failed | 0 | fixing-1 |
| 2026-02-19 | [TEST] Add unit tests for shell script lock acquisition and task claiming — test PID lock, mkdir mutex, stale detection, and concurrent worker scenarios | merged to main | playwright tests failed | 1 | fixed |
| 2026-02-19 | [TEST] Add TypeScript tests for API handlers — test pipeline-status, tasks POST, prompts extraction, monitoring-agents response shapes | merged to main | playwright tests failed | 1 | fixed |
| 2026-02-19 | [FEAT] Add mission progress tracking to project-driver — parse mission.md success criteria, track completion percentage, report in dashboard | dev/add-mission-progress-tracking-to-project | playwright tests failed | 0 | fixing-2 |
| 2026-02-19 | [FEAT] Add mission.md viewer tab to admin dashboard — display the current mission with progress indicators next to each success criterion | dev/add-missionmd-viewer-tab-to-admin-dashbo | playwright tests failed | 0 | fixing-3 |
| 2026-02-19 | [INFRA] Add CI/CD workflow — GitHub Actions for typecheck, Playwright e2e, and shell script linting on every PR | dev/add-cicd-workflow--github-actions-for-ty | playwright tests failed | 0 | superseded |
| 2026-02-19 | [FEAT] Add webhook notification support — Slack and Discord channels alongside Telegram via pluggable _notify.sh | dev/add-webhook-notification-support--slack- | playwright tests failed | 0 | superseded |
| 2026-02-19 | [FEAT] we need to be able to see in admin for pipeline and monitoring who is active | dev/we-need-to-be-able-to-see-in-admin-for-p | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [TEST] Add integration test for full pipeline task lifecycle — create tests/integration/pipeline-lifecycle.test.sh | dev/add-integration-test-for-full-pipeline-t | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [FEAT] Add `skynet logs` CLI command — create packages/cli/src/commands/logs.ts (old spec) | dev/add-skynet-logs-cli-command--create-pack | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [TEST] Add Playwright tests for all dashboard component interactions — expand/collapse, tab switching, trigger buttons, log viewer, mission viewer tab, metrics display | dev/add-playwright-tests-for-all-dashboard-c | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [INFRA] Add more tags and add tooltip to them — ability to fine define tasks | dev/add-more-tags-and-add-tooltip-to-them--a | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [FEAT] Add `skynet add-task` CLI command for backlog injection (old spec) | dev/title--description-optionally-appends--- | merge conflict | 0 | superseded |
| 2026-02-19 | [FEAT] Add Linux cron support to monitoring agents dashboard | dev/add-linux-cron-support-to-monitoring-age | merge conflict | 0 | superseded |
| 2026-02-19 | [FEAT] Add automatic stale branch cleanup for abandoned failed tasks | dev/add-automatic-stale-branch-cleanup-for-a | merge conflict | 0 | superseded |
| 2026-02-19 | [FIX] Fix watchdog hardcoded worker IDs breaking scaling beyond 2 workers | dev/fix-watchdog-hardcoded-worker-ids-breaki | merge conflict | 0 | superseded |
| 2026-02-19 | [FEAT] Add multi-project PID isolation validation | dev/add-multi-project-pid-isolation-validati | merge conflict | 0 | superseded |
| 2026-02-19 | [INFRA] Delete stale dev branches and prune worktrees | dev/delete-stale-dev-branches-and-prune-work | merge conflict | 0 | superseded |
