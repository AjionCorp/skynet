# Current Task
## [DOCS] Add troubleshooting section to README.md — append a `## Troubleshooting` section to `README.md` covering: (1) **Workers stuck or stale** — run `skynet doctor`, check heartbeats with `skynet status`, restart with `skynet stop && skynet start`. (2) **Task keeps failing** — check fixer logs with `skynet logs fixer`, manually retry with `skynet reset-task "task name"`. (3) **Merge conflicts on retry** — task-fixer auto-detects conflicts and creates fresh branches, explain the mechanism. (4) **Dashboard not loading** — verify port 3100 is free, try `skynet dashboard --port 3101`, check Node.js version. (5) **Auth expired** — re-authenticate with `claude auth login`, the auth-refresh agent syncs automatically. (6) **Backlog empty but mission not complete** — watchdog kicks project-driver automatically when backlog < 5 tasks. Keep under 60 lines total
**Status:** completed
**Started:** 2026-02-19 17:46
**Completed:** 2026-02-19
**Branch:** dev/add-troubleshooting-section-to-readmemd-
**Worker:** 1

### Changes
-- See git log for details
