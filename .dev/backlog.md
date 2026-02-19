# Backlog

<!-- Priority: top = highest. Format: - [ ] [TAG] Task title — description -->
<!-- Markers: [ ] = pending, [>] = claimed by worker, [x] = done -->

- [x] [FEAT] Add configurable quality gates via skynet.config.sh — replace hardcoded typecheck+playwright gates in dev-worker.sh (lines ~140-180) and task-fixer.sh (lines ~165-220) with a SKYNET_GATES array. Add SKYNET_GATE_1="pnpm typecheck" etc. to skynet.config.sh. Loop through defined gates in both scripts. Default: just typecheck. This makes the pipeline generic for any project's CI needs
- [x] [FEAT] Add `skynet status` CLI command — create packages/cli/src/commands/status.ts that reads .dev/backlog.md, completed.md, failed-tasks.md, current-task.md, and worker PID lock files. Display: task counts by state, current task name+duration, worker PIDs and status, last activity timestamp, recent completions. Register in packages/cli/src/index.ts
- [ ] [FEAT] we need to be able to see in admin for pipeline and monitoring who is active
- [x] [INFRA] Lets have an ability to add more workers to different areas from the admin dynamically, say i want to increase the tester or fixer capacity or which ever i should be able to
- [x] [FEAT] Lets improve Pipeline and Monitoring for admin — some things are either dated or missing
- [x] [FEAT] Add worker heartbeat and stale detection — workers write a timestamp to .dev/worker-N.heartbeat every 60s during task execution (add periodic write in dev-worker.sh main implementation loop). watchdog.sh checks heartbeats on each run: if any heartbeat is older than SKYNET_STALE_MINUTES, kill the worker, unclaim its task in backlog.md, remove the worktree, reset current-task-N.md to idle
- [x] [FEAT] Add agent plugin system for LLM-agnostic workers — extract Claude Code and Codex CLI invocation from scripts/_config.sh run_agent() into separate plugins at scripts/agents/claude.sh and scripts/agents/codex.sh. Define standard interface: run_agent "prompt" "logfile" returns exit code. Add SKYNET_AGENT_PLUGIN config to skynet.config.sh. Allow custom agent scripts via file path
- [>] [INFRA] Add shellcheck linting for all shell scripts — add shellcheck as a dev dependency or document it as required tool, create `pnpm lint:sh` script that runs shellcheck on all scripts/*.sh files, fix reported issues (unquoted vars, missing error handling), integrate into the CI workflow
- [ ] [TEST] Add integration test for full pipeline task lifecycle — create tests/integration/pipeline-lifecycle.test.sh. Test the complete flow: add task to backlog.md → claim_next_task() → verify worktree creation → simulate implementation → run quality gates → verify merge to main and completed.md entry. Also test failure path: task fails gates → logged in failed-tasks.md → task-fixer picks it up
- [ ] [FEAT] Add `skynet logs` CLI command — create packages/cli/src/commands/logs.ts that tails or displays recent entries from .dev/scripts/*.log files. Support `skynet logs worker` (dev-worker), `skynet logs fixer` (task-fixer), `skynet logs watchdog`, `skynet logs --follow` for real-time tailing. Register in packages/cli/src/index.ts
- [ ] [TEST] Add Playwright tests for all dashboard component interactions — expand/collapse, tab switching, trigger buttons, log viewer, mission viewer tab, metrics display
- [ ] [INFRA] Add more tags and add tooltip to them — ability to fine define tasks
- [x] [FEAT] Add task dependency tracking — extend backlog.md syntax to support `blockedBy: task-title` metadata, update claim_next_task() in dev-worker.sh to skip tasks whose dependencies are not yet completed, add dependency visualization to dashboard tasks page
- [x] [FEAT] Add real-time pipeline dashboard via Server-Sent Events — create /api/admin/pipeline/stream route that watches .dev/ files for changes using fs.watch and streams status updates, update packages/admin/src/app/admin/pipeline/page.tsx to consume SSE instead of polling
- [x] [FEAT] Add crash recovery to watchdog _(playwright failed — retry pending, branch has implementation)_
- [x] [FEAT] Add `skynet start` and `skynet stop` CLI commands _(task-fixer retry in progress)_
- [x] [INFRA] Add npm package build and publish workflow _(playwright failed — retry pending, branch has implementation)_
- [x] [FEAT] Add self-correction metrics tracking _(playwright failed — retry pending, branch has implementation)_
- [x] [TEST] Add unit tests for shell script lock acquisition and task claiming _(playwright failed — retry pending, branch has implementation)_
- [x] [TEST] Add TypeScript tests for API handlers _(playwright failed — retry pending, branch has implementation)_
- [x] [FEAT] Add mission progress tracking to project-driver _(playwright failed — retry pending, branch has implementation)_
- [x] [FEAT] Add mission.md viewer tab to admin dashboard _(playwright failed — retry pending, branch has implementation)_
- [x] [INFRA] Add CI/CD workflow _(playwright failed — retry pending, branch has implementation)_
- [x] [FEAT] Add webhook notification support _(playwright failed — retry pending, branch has implementation)_
- [x] [INFRA] Add cron support alongside launchd _(playwright failed)_
