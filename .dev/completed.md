# Completed Tasks

| Date | Task | Branch | Duration | Notes |
|------|------|--------|----------|-------|
| 2026-02-24 | [FEAT] Add dark/light theme toggle to AdminLayout | merged to main | 6m | success |
| 2026-02-24 | [FEAT] [FEAT] Add task detail drawer to Tasks page | merged to main | 7m | success |
| 2026-02-24 | [FEAT] [FEAT] Add task search and tag filter to Tasks page | merged to main | 2m | success |
| 2026-02-20 | [DOCS] Update README CLI reference with run, watch, upgrade, and metrics commands | merged to main | 0m | success |
| 2026-02-20 | [INFRA] Add pipeline velocity metrics to project-driver.sh prompt context | merged to main | 0m | echo 0)`, `total_completed=$(grep -c '^ |
| 2026-02-20 | [FEAT] Wire emit_event() calls into dev-worker.sh, task-fixer.sh, and watchdog.sh | merged to main | 2m | success |
| 2026-02-20 | [FIX] Delete stale dev/* branches for all superseded failed tasks | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add EventsDashboard component and `/admin/events` page | merged to main | 4m | success |
| 2026-02-20 | [TEST] Add `metrics.test.ts` CLI unit test | merged to main | 1m | success |
| 2026-02-20 | [FEAT] Add `skynet export` CLI command for pipeline state snapshot | merged to main | 1m | success |
| 2026-02-20 | [TEST] Add CLI unit tests for watch, run, upgrade, and cleanup commands | merged to main | 4m | success |
| 2026-02-20 | [TEST] Add EventsDashboard component tests | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [DOCS] Add npm package README for @ajioncorp/skynet-cli | merged to main | 1m | success |
| 2026-02-20 | [INFRA] Add standalone `build` verification job to CI workflow | merged to main | 0m | success |
| 2026-02-20 | [TEST] Add `status.test.ts` CLI unit test | merged to main | 2m | success |
| 2026-02-20 | [TEST] Add `pause.test.ts`, `resume.test.ts`, `reset-task.test.ts`, and `setup-agents.test.ts` CLI unit tests | merged to main | 4m | success |
| 2026-02-20 | [TEST] Add `logs.test.ts`, `start.test.ts`, `stop.test.ts`, and `version.test.ts` CLI unit tests | merged to main | 4m | success |
| 2026-02-20 | [INFRA] Add health score alert notification to watchdog | merged to main | 2m | success |
| 2026-02-20 | [INFRA] Add project-driver backlog deduplication check | merged to main | 3m | success |
| 2026-02-20 | [FEAT] Add `skynet import` CLI command for restoring pipeline state from snapshot | merged to main | 2m | success |
| 2026-02-20 | [FEAT] Add `skynet doctor --fix` auto-remediation mode | merged to main | 2m | success |
| 2026-02-20 | [INFRA] Add automatic merge retry with rebase in dev-worker.sh | merged to main | 1m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 2m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [TEST] Add `export.test.ts`, `dashboard.test.ts`, and `import.test.ts` CLI unit tests | merged to main | 5m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [INFRA] Add agent execution timeout to prevent zombie agent processes | merged to main | 6m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 1m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 0m | success |
| 2026-02-20 | [INFRA] Add SSE auto-reconnection with backoff to PipelineDashboard | 'reconnecting' | 0m | 'disconnected') displayed as a small colored indicator (green/yellow/red dot) next to the page title, (d) handle `document.visibilitychange` — close SSE when tab is hidden, reopen when visible to save server resources. Keep the existing polling fallback intact for browsers that don't support SSE. Criterion #4 (reliable real-time dashboard visibility) |
| 2026-02-20 | [FEAT] Add config auto-migration to detect and add new variables on upgrade | merged to main | 2m | success |
| 2026-02-20 | [TEST] Expand E2E CLI test suite with export/import round-trip and doctor --fix verification | merged to main | 5m | success |
| 2026-02-20 | [FEAT] Add `skynet test-notify` CLI command for notification channel verification | merged to main | 7m | success |
| 2026-02-20 | [FIX] Update config.ts KNOWN_VARS dictionary with missing config variable descriptions | merged to main | 0m | success |
| 2026-02-20 | [FIX] Remove duplicate `_cleanup_stale_branches` function in watchdog.sh | superseded | 0m | blocked statuses, deletes local+remote branches for all resolved failed tasks) and again at line ~503 (only handles blocked entries with 24h+ age check against blockers.md). The first definition runs at line ~487 and already comprehensively handles ALL resolved statuses including blocked. The second definition at ~503 silently redefines the function, then runs at ~570 doing redundant work (blocked branches were already deleted by the first call). Fix: delete the second function definition — remove the comment block starting with `# --- Stale branch cleanup for permanently failed tasks ---` (line ~500) through the closing brace (line ~567), and delete its invocation `_cleanup_stale_branches` at line ~570. Also remove the `cd "$PROJECT_DIR"` line just before it (line ~569) since it's only needed by the second call. The first, comprehensive version already covers all cases. This is a real bug from two separate tasks being merged independently. Run `pnpm typecheck` to verify no breakage. Criterion #3 (clean code, no redundant logic) |
| 2026-02-20 | [DOCS] Update README.md and packages/cli/README.md CLI reference tables with missing commands | merged to main | 0m | success |
| 2026-02-20 | [TEST] Add `completions.test.ts` CLI unit test | merged to main | 2m | success |
| 2026-02-20 | [TEST] Add `test-notify.test.ts` CLI unit test | merged to main | 1m | success |
| 2026-02-20 | [TEST] Add `config-migrate.test.ts` CLI unit test for config migrate subcommand | merged to main | 2m | success |
| 2026-02-20 | [TEST] Add `AdminLayout.test.tsx` and `SkynetProvider.test.tsx` component tests | merged to main | 3m | success |
| 2026-02-20 | [FEAT] Add `skynet init --from-snapshot` to bootstrap from exported state | merged to main | 1m | success |
| 2026-02-20 | [FEAT] Add `skynet changelog` CLI command for release note generation | merged to main | 2m | success |
| 2026-02-20 | [FIX] Fix `sync-runner.sh` pre-flight check using non-existent API route | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix `check-server-errors.sh` hardcoded log path breaking multi-worker server error scanning | merged to main | 0m | success |
| 2026-02-20 | [FIX] Add missing handler and type exports to `packages/dashboard/src/index.ts` | merged to main | 1m | success |
| 2026-02-20 | [FIX] Add `tg` notification and `emit_event` when task-fixer escalates task to blocked | merged to main | 0m | success |
| 2026-02-20 | [INFRA] Add CI job dependency chain to save GitHub Actions minutes | merged to main | 0m | success |
| 2026-02-20 | [TEST] Add `changelog.test.ts` CLI unit test | merged to main | 1m | success |
| 2026-02-20 | [INFRA] Add Playwright E2E tests for events, logs, settings, and workers admin pages | merged to main | 2m | success |
| 2026-02-20 | [FEAT] Add `skynet validate` CLI command for pre-flight project validation | merged to main | 2m | success |
| 2026-02-20 | [FIX] Fix stale lock recovery using wrong backlog marker causing 0m re-executions | merged to main | 0m | success |
| 2026-02-20 | [FIX] Truncate completed.md to last 30 entries in project-driver.sh prompt context | merged to main | 1m | success |
| 2026-02-20 | [FIX] Fix project-driver deduplication to include completed.md and `[x]` backlog entries | ' 'NR>2 {t=$3; gsub(/^ + | 0m | +$/,"",t); if(t!="") print "- [ ] " t}' "$COMPLETED" >> "$_dedup_snapshot"; while IFS= read -r _line; do _normalize_task_line "$_line"; done < <(tail -n +3 "$_dedup_snapshot") >> "$_dedup_normalized"; fi`. This ensures tasks already in completed.md are never regenerated. Run `pnpm typecheck`. Criterion #3 (no wasted cycles — this single bug wasted ~30% of all API credits) |
| 2026-02-20 | [FIX] Add merge retry with rebase to task-fixer.sh | merged to main | 1m | success |
| 2026-02-20 | [FIX] Fix dynamic Tailwind class names getting purged in production PipelineDashboard | merged to main | 1m | success |
| 2026-02-20 | [FIX] Fix is_task_blocked() to also check completed.md for dependency resolution | merged to main | 0m | success |
| 2026-02-20 | [INFRA] Add completed.md archival to prevent unbounded state file growth | merged to main | 2m | success |
| 2026-02-20 | [TEST] Add `validate.test.ts` CLI unit test | merged to main | 1m | success |
| 2026-02-20 | [FIX] Fix sync-runner.sh bash 3.2 array syntax incompatibility | merged to main | 1m | success |
| 2026-02-20 | [FIX] Make LogViewer worker/fixer count dynamic instead of hardcoded | merged to main | 3m | success |
| 2026-02-20 | [INFRA] Extract loadConfig() to shared CLI utility module | null` function with the fixed regex (supporting both quoted and unquoted values). Update all 19 files to `import { loadConfig } from '../utils/loadConfig'` and delete their local copies. This makes future config parser changes (like the unquoted value fix) a single-file change instead of 19. Run `pnpm typecheck`. Criterion #3 (maintainable code — DRY principle) | 0m | merged to main |
| 2026-02-20 | [FIX] Cap pipeline-status handler `completed` array to last 50 entries | merged to main | 0m | success |
| 2026-02-20 | [FIX] Move health alert sentinel from `.dev/` to `/tmp/` | merged to main | 0m | success |
| 2026-02-20 | [FIX] Pass agent prompt via stdin instead of CLI argument to avoid ARG_MAX | _agent_exec $SKYNET_CLAUDE_BIN $SKYNET_CLAUDE_FLAGS --print -` or write to a temp file and pass via `cat`. Check the `_agent_exec` function in `scripts/_agent.sh` to ensure stdin piping is compatible. If using a temp file, ensure it's cleaned up in the trap handler. Test with a large prompt string (>500KB) to verify. Run `pnpm typecheck`. Criterion #3 (reliability — prevents silent failures on large projects with extensive conventions) | 0m | merged to main |
| 2026-02-20 | [FIX] Replace `[[` with `case` in watchdog.sh for bash 3.2 style consistency | merged to main | 0m | continue`. While `[[` technically works in bash 3.2, the project's shell rules state bash 3.2 compatibility and the rest of the codebase uses `[ ... ]` exclusively. This is the only `[[` usage in the pipeline scripts (except `_compat.sh` for platform detection). Fix: replace with a `case` statement: `case "$branch" in dev/*) ;; *) continue ;; esac`. Run `bash -n scripts/watchdog.sh` and `pnpm typecheck` to verify. Criterion #1 (portability — consistent bash 3.2 style across all scripts) |
| 2026-02-20 | [FIX] Add missing KNOWN_VARS entries for SKYNET_WORKER_CONTEXT, SKYNET_WORKER_CONVENTIONS, and SKYNET_WATCHDOG_INTERVAL | merged to main | 0m | success |
| 2026-02-20 | [FIX] Use mkdir-based atomic lock for watchdog PID singleton enforcement | merged to main | 6m | success |
| 2026-02-20 | [FIX] Make start-dev.sh accept worker ID for per-worker log and PID file isolation | merged to main | 1m | success |
| 2026-02-20 | [FIX] Consolidate duplicate port config variables `SKYNET_DEV_SERVER_PORT` and `SKYNET_DEV_PORT` | merged to main | 1m | success |
| 2026-02-20 | [FIX] Use configurable `SKYNET_AUTH_NOTIFY_INTERVAL` in auth-check.sh instead of hardcoded value | merged to main | 1m | success |
| 2026-02-20 | [FIX] Consolidate duplicate `PipelineStatus` and `MonitoringStatus` types | merged to main | 0m | success |
| 2026-02-20 | [INFRA] Add `timeout-minutes` to all CI workflow jobs to prevent runaway builds | merged to main | 0m | success |
| 2026-02-20 | [FIX] Make worker-scaling handler read `SKYNET_MAX_FIXERS` from config instead of hardcoding 3 | merged to main | 2m | success |
| 2026-02-20 | [FEAT] Add `echo` agent plugin for pipeline dry-run testing | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix TypeScript backlog mutex path missing dash separator | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix pipeline-status.ts `handlerCount` always returning 0 in production builds | merged to main | 0m | f.endsWith(".js")` and exclude both `.test.ts` and `.test.js`. Alternatively, hardcode the handler count as a known constant (currently 10 handlers) since it changes rarely and counting compiled files is inherently fragile. Run `pnpm typecheck` and `pnpm build` to verify. Criterion #4 (dashboard shows correct mission progress in production) |
| 2026-02-20 | [FIX] Fix watchdog zombie detection to check heartbeat before killing alive workers | merged to main | 1m | success |
| 2026-02-20 | [FIX] Fix `skynet stop` and `skynet doctor` hardcoded worker lists | merged to main | 1m | success |
| 2026-02-20 | [INFRA] Add typecheck and test steps to publish-cli.yml before npm publish | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix watchdog `_archive_old_completions` date comparison using `<` in `[ ]` | sort | 0m | head -1)" = "$entry_date" ]` and `[ "$entry_date" != "$cutoff_date" ]`. Run `bash -n scripts/watchdog.sh` and `pnpm typecheck`. Criterion #1 (portability — bash 3.2 on macOS) |
| 2026-02-20 | [FIX] Migrate task-fixer.sh and project-driver.sh to mkdir-based atomic PID locks | merged to main | 0m | { ... }; echo $$ > "$LOCKFILE/pid"`. Update `cleanup_on_exit` at line 155 from `rm -f "$LOCKFILE"` to `rm -rf "$LOCKFILE"`. (2) Apply the same pattern to `project-driver.sh` lines 26-31 and its cleanup. (3) In `dev-worker.sh` line 395, update the project-driver lock check from `cat "${SKYNET_LOCK_PREFIX}-project-driver.lock"` to `cat "${SKYNET_LOCK_PREFIX}-project-driver.lock/pid"` since the lock is now a directory. Run `pnpm typecheck` and `bash -n scripts/task-fixer.sh scripts/project-driver.sh`. Criterion #3 (no race conditions — prevents duplicate fixer/driver instances) |
| 2026-02-20 | [FIX] Fix health-check.sh unquoted `$SKYNET_LINT_CMD` causing word splitting | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix `_agent.sh` relative plugin path resolution breaking custom agents | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix duplicate Activity icon for events page in admin navigation | merged to main | 0m | success |
| 2026-02-20 | [FIX] Remove ghost `SKYNET_START_DEV_CMD` from config.ts KNOWN_VARS | merged to main | 0m | success |
| 2026-02-20 | [FIX] Add `SKYNET_WORKER_CONTEXT` and `SKYNET_WORKER_CONVENTIONS` as commented-out examples in config template | merged to main | 0m | success |
| 2026-02-20 | [FIX] Validate git repository during `skynet init` | merged to main | 0m | success |
| 2026-02-20 | [INFRA] Add publish workflow for `@ajioncorp/skynet` dashboard package | merged to main | 0m | success |
| 2026-02-20 | [DOCS] Add README.md for `@ajioncorp/skynet` dashboard package | merged to main | 2m | success |
| 2026-02-20 | [FIX] Fix `skynet logs` column header using unsupported printf format specifiers | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix CI `lint-sh` job missing pnpm setup causing every shell lint run to fail | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix worker-scaling handler using `unlinkSync` on directory-based lock files | merged to main | 0m | success |
| 2026-02-20 | [FIX] Read CLI version from package.json instead of hardcoding "0.1.0" | merged to main | 1m | success |
| 2026-02-20 | [FIX] Fix health-check.sh lock path using `$SCRIPTS_DIR` instead of `$SKYNET_LOCK_PREFIX` | merged to main | 0m | success |
| 2026-02-20 | [FIX] Use `sed_inplace` wrapper in task-fixer.sh instead of raw `sed -i.bak` | fixing-${FIXER_ID} | 0m | / |
| 2026-02-20 | [FIX] Migrate sync-runner.sh, feature-validator.sh, and ui-tester.sh to mkdir-based atomic PID locks | merged to main | 0m | { ... check stale ... exit 0; }; echo $$ > "$LOCKFILE/pid"`. Update each cleanup trap from `rm -f "$LOCKFILE"` to `rm -rf "$LOCKFILE"`. Follow the exact pattern in `scripts/health-check.sh` lines 17-32 (which already uses mkdir). Run `bash -n scripts/sync-runner.sh scripts/feature-validator.sh scripts/ui-tester.sh` and `pnpm typecheck`. Criterion #3 (no race conditions — consistent locking across all scripts) |
| 2026-02-20 | [INFRA] Add `permissions: contents: read` to CI workflow and npm metadata to published packages | merged to main | 1m | success |
| 2026-02-20 | [FIX] Replace `&>/dev/null` bashism with portable `>/dev/null 2>&1` in 8 script locations | merged to main | 1m | success |
| 2026-02-20 | [FIX] Add `validate`, `changelog`, and `--from-snapshot` to completions.ts | merged to main | 0m | success |
| 2026-02-20 | [FIX] Add `SKYNET_ONE_SHOT` and `SKYNET_ONE_SHOT_TASK` to config.ts KNOWN_VARS | merged to main | 0m | success |
| 2026-02-20 | [DOCS] Update README.md with missing CLI commands, dashboard components, and config vars | merged to main | 1m | success |
| 2026-02-20 | [INFRA] Add `pnpm install --frozen-lockfile` to worker flow before typecheck | merged to main | 1m | success |
| 2026-02-20 | [FIX] Add `worker` field to `EventEntry` interface and display in dashboard | merged to main | 2m | success |
| 2026-02-20 | [FIX] Fix dashboard typecheck | merged to main | 12m | success |
| 2026-02-20 | [FIX] Fix dashboard typecheck | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix `sed -n 'Ip'` GNU extension breaking `blockedBy` dependency parsing on macOS | *blockedBy: *\(.*\)$/\1/Ip'` uses the `I` (case-insensitive) flag which is a GNU sed extension NOT available in macOS BSD sed. On macOS (the primary target platform), `blocked_by` is always empty, meaning `is_task_blocked()` never detects blocked tasks — workers attempt blocked tasks immediately, wasting cycles and producing incorrect results. Same issue in `scripts/_config.sh` line 231 inside `validate_backlog()`. Fix: replace `sed -n 's/.* | 0m | *blockedBy: *\(.*\)$/\1/Ip'` with `sed -n 's/.* |
| 2026-02-20 | [FIX] Add `git pull` before first merge attempt in dev-worker.sh and task-fixer.sh to reduce unnecessary conflicts | merged to main | 0m | true` between lines 588 and 590 (after `cd "$PROJECT_DIR"`, before the first `git merge`). Apply the same fix in `scripts/task-fixer.sh` before its merge attempt at line 445. Run `bash -n` on both files and `pnpm typecheck`. Criterion #3 (reliability — proactively prevent merge conflicts instead of recovering from them) |
| 2026-02-20 | [FIX] Add backlog mutex lock to CLI `add-task` and `reset-task` commands to prevent data corruption | merged to main | 2m | success |
| 2026-02-20 | [FIX] Guard `skynet init` against re-run silently overwriting existing `skynet.config.sh` | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix task POST handler to retry lock acquisition instead of immediate 423 failure | merged to main | 0m | success |
| 2026-02-20 | [FIX] Improve watchdog auto-supersede to catch stale failed-tasks with title variations | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Remove shell-execution path from `skynet config set` | merged to main | 2m | success |
| 2026-02-20 | [FIX] Add canonical failed-task reconciliation in watchdog | merged to main | 0m | success |
| 2026-02-20 | [FIX] Add `files` field and `prepublishOnly` script to dashboard package.json for correct npm publish | merged to main | 1m | fixed (attempt 3) |
| 2026-02-20 | [FIX] Prevent duplicate pending failed rows at write-time in `scripts/task-fixer.sh` | merged to main | 2m | success |
| 2026-02-20 | [FIX] Fix Node.js version prerequisite mismatch in README | merged to main | 0m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Add `SKYNET_INSTALL_CMD` config variable for non-pnpm projects | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Read `SKYNET_STALE_MINUTES` from config in pipeline-status handler and CLI status instead of hardcoding 45 | merged to main | 2m | fixed (attempt 2) |
| 2026-02-20 | [INFRA] Commit and verify orphaned `main` working-tree fixes from killed workers | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Supersede 21 stale `pending` entries in `failed-tasks.md` for already-completed tasks | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Read `SKYNET_STALE_MINUTES` from config in `status.ts`, `watch.ts`, and `pipeline-status.ts` instead of hardcoding 45 | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Remove any remaining shell-execution path from `skynet config set` | merged to main | 2m | success |
| 2026-02-20 | [INFRA] Land orphaned `main` hardening changes in atomic commits | merged to main | 2m | success |
| 2026-02-20 | [FIX] Run canonical failed-task reconciliation and one-time cleanup sweep | merged to main | 2m | success |
| 2026-02-20 | [FIX] Unify stale-threshold and health-score parity across CLI/dashboard/watchdog | merged to main | 3m | success |
| 2026-02-20 | [FIX] Make stale heartbeat threshold config-consistent everywhere | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Patch shell injection risk in `skynet config set` | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Enforce duplicate-pending prevention at write-time in `task-fixer.sh` | merged to main | 1m | success |
| 2026-02-20 | [FIX] Align watchdog health score math with CLI/dashboard | merged to main | 2m | fixed (attempt 2) |
| 2026-02-20 | [DOCS] Add hardening-phase operator runbook to `README.md` | merged to main | 1m | success |
| 2026-02-20 | [INFRA] Add backlog-empty recovery generation in `project-driver.sh` | merged to main | 2m | success |
| 2026-02-20 | [FIX] Restore config template parity for watchdog/one-shot knobs | merged to main | 1m | success |
| 2026-02-20 | [FIX] Drain stale `pending` retries in `failed-tasks.md` after supersede normalization lands | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Complete CLI process/file helper DRY extraction with lock-compat coverage | merged to main | 1m | success |
| 2026-02-20 | [FIX] Finish backlog parser DRY extraction with behavior-parity tests | merged to main | 1m | success |
| 2026-02-20 | [NMI] Canonicalize blocked retry roots from `.dev/failed-tasks.md` | merged to main | 1m | success |
| 2026-02-20 | [TEST] Add regression coverage for stale-threshold + health-score parity | merged to main | 4m | fixed (attempt 1) |
| 2026-02-20 | [TEST] Re-open CLI operational E2E smoke coverage (single canonical task) | merged to main | 4m | success |
| 2026-02-20 | [INFRA] Add project-driver guardrail when backlog is empty but retries exist | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Finish backlog parser DRY extraction with behavior-parity tests | merged to main | 2m | success |
| 2026-02-20 | [INFRA] Run one canonical failed-task reconciliation sweep and supersede variants | merged to main | 3m | success |
| 2026-02-20 | [NMI] Canonicalize blocked retry roots from `.dev/failed-tasks.md` | merged to main | 1m | success |
| 2026-02-20 | [DOCS] Add a concise “Mission Achieved / Hardening Phase” operator note to README | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [INFRA] Execute one canonical failed-task cleanup pass after reconciliation | merged to main | 2m | success |
| 2026-02-20 | [FIX] Stabilize Codex large-prompt path with deterministic exit-code preservation | merged to main | 3m | success |
| 2026-02-20 | [TEST] Re-open CLI operational E2E smoke coverage (single canonical task) | merged to main | 5m | success |
| 2026-02-20 | [FIX] Consolidate duplicate pending failed-task entries at write time in `task-fixer.sh` | merged to main | 2m | fixed (attempt 2) |
| 2026-02-20 | [INFRA] Run one canonical failed-task reconciliation sweep and supersede variants | merged to main | 2m | success |
| 2026-02-20 | [NMI] Produce diagnostics bundle for blocked roots before requeue | merged to main | 0m | success |
| 2026-02-20 | [INFRA] Land orphaned main working-tree fixes with clean commits | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Restore config template parity for watchdog and one-shot knobs | merged to main | 1m | success |
| 2026-02-20 | [FIX] Remove shell-eval injection path from `skynet config set` | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Finish Codex large-prompt reliability path | merged to main | 3m | fixed (attempt 3) |
| 2026-02-20 | [INFRA] Enforce canonical failed-task convergence before fixer dispatch | fixing-* | 0m | blocked`) in `.dev/failed-tasks.md`, supersedes duplicates, and emits per-root reconciliation counts. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state. |
| 2026-02-20 | [FIX] Throttle net-new task generation when retry queue is overloaded | merged to main | 1m | success |
| 2026-02-20 | [INFRA] Prevent project-driver re-queue variants for known failed roots | merged to main | 1m | success |
| 2026-02-20 | [NMI] Emit blocked-root diagnostics snapshot from current logs | merged to main | 2m | success |
| 2026-02-20 | [FIX] Run one-time failed-task normalization and supersede sweep | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Unify stale-threshold config usage across CLI + dashboard + watchdog math | merged to main | 4m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Prevent duplicate pending rows at write time in `scripts/task-fixer.sh` | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [INFRA] Add backlog-empty recovery generation in `scripts/project-driver.sh` | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Finish Codex large-prompt path with exit-code preservation | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [INFRA] Reconcile stale `fixing-*` failed-task rows by fixer lock liveness | merged to main | 2m | success |
| 2026-02-20 | [TEST] Add parity regression tests for stale threshold and health score | merged to main | 3m | fixed (attempt 1) |
| 2026-02-20 | [INFRA] Re-open hardening commit sweep on `main` | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [NMI] Refresh blockers Active from blocked roots with exact diagnostics | merged to main | 4m | success |
| 2026-02-20 | [FIX] Re-open `skynet config set` shell injection fix | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Unblock pipeline-logs buffer line-count optimization root | merged to main | 1m | success |
| 2026-02-20 | [FIX] Re-open failed-task normalization and supersede sweep | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Re-open duplicate pending write prevention in `scripts/task-fixer.sh` | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Re-open stale-threshold parity across CLI/dashboard/watchdog | merged to main | 4m | fixed (attempt 2) |
| 2026-02-20 | [TEST] Unblock canonical CLI operational E2E smoke root (`stop`, `pause/resume`, `completions`, `validate`) | merged to main | 7m | success |
| 2026-02-20 | [TEST] Add regression coverage for canonicalization invariants across watchdog/task-fixer/project-driver | merged to main | 2m | success |
| 2026-02-20 | [FIX] Unblock pipeline-logs buffer line-count optimization root with response-shape parity | merged to main | 2m | success |
| 2026-02-20 | [INFRA] Canonicalize active failed-task roots and collapse duplicate variants | fixing-* | 0m | blocked`), supersede redundant variants, and emit before/after root counts to logs/events. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state. |
| 2026-02-20 | [NMI] Refresh blocked-root diagnostics snapshot to one canonical row per root cause | merged to main | 3m | success |
| 2026-02-20 | [INFRA] Harden project-driver prompt/task postfilter for durable root-cause titles | merged to main | 2m | success |
| 2026-02-20 | [TEST] Re-open parity regression coverage for stale-threshold and health-score math | merged to main | 4m | fixed (attempt 1) |
| 2026-02-20 | [INFRA] Execute one idempotent failed-task canonical cleanup run and verify convergence | merged to main | 1m | success |
| 2026-02-20 | [INFRA] Execute one idempotent failed-task canonical cleanup run and verify convergence | merged to main | 1m | success |
| 2026-02-20 | [FIX] Re-open Codex large-prompt reliability path | merged to main | 3m | fixed (attempt 2) |
| 2026-02-20 | [INFRA] Land orphaned `main` hardening changes with clean commit split | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Unblock Codex large-prompt reliability root (canonical) | merged to main | 3m | success |
| 2026-02-20 | [FIX] Unblock config template parity root for one-shot/watchdog vars | merged to main | 1m | success |
| 2026-02-20 | [INFRA] Land orphaned `main` hardening changes with clean commit split | merged to main | 2m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Unblock pipeline-logs buffer line-count optimization root with response-shape parity | merged to main | 3m | success |
| 2026-02-20 | [INFRA] Canonicalize active failed-task roots and collapse duplicate variants | fixing-* | 0m | blocked`), supersede redundant variants, and emit before/after root counts to logs/events. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state. |
| 2026-02-20 | [FIX] Unblock dashboard backlog-parser DRY extraction root | merged to main | 1m | success |
| 2026-02-20 | [FIX] Unblock CLI shared helper DRY root for `readFile`/`isProcessRunning` | merged to main | 1m | success |
| 2026-02-20 | [INFRA] Supersede legacy duplicate pending failed roots after canonicalization pass | merged to main | 1m | success |
