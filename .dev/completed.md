# Completed Tasks

| Date | Task | Branch | Duration | Notes |
|------|------|--------|----------|-------|
| 2026-03-03 | [INFRA] Complete echo agent dry-run lifecycle in scripts/agents/echo.sh | merged to main | 0m | success |
| 2026-03-03 | [INFRA] Sync backlog.md claimed markers with DB state during watchdog reconciliation | merged to main | 3m | success |
| 2026-03-03 | [FIX] Separate rate_limits write path from read-only DB access | merged to main | 0m | success |
| 2026-03-03 | [DATA] Refresh blockers.md Active section to match current resolved state | merged to main | 9m | success |
| 2026-03-03 | [FEAT] Add keyboard shortcuts to dashboard | merged to main | 2m | success |
| 2026-03-03 | [FEAT] Add task completion velocity chart to Pipeline dashboard | merged to main | 0m | success |
| 2026-03-03 | [FEAT] Add pipeline health trend sparkline to Pipeline dashboard | merged to main | 6m | success |
| 2026-02-25 | [DATA] [DATA] Surface failed-row reconciliation counters in CLI/dashboard status JSON | merged to main | 2m | success |
| 2026-02-25 | [TEST] [TEST] Add unit tests for `_locks.sh` atomic locking and merge mutex | merged to main | 1m | success |
| 2026-02-24 | [INFRA] Add task-fixer structured diagnostics for fix rate improvement | merged to main | 6m | success |
| 2026-02-24 | [FIX] Extract duplicated mission evaluation logic from CLI status to shared module | merged to main | 13m | success |
| 2026-02-24 | [FIX] Deduplicate repeated entries in completed.md | merged to main | 9m | success |
| 2026-02-24 | [TEST] Add Linux cron setup-agents regression test | merged to main | 4m | success |
| 2026-02-24 | [INFRA] Prune stale local dev/* branches from resolved failed tasks | merged to main | 5m | success |
| 2026-02-24 | [INFRA] Archive resolved failed-task rows to bound state file size | merged to main | 4m | success |
| 2026-02-24 | [FEAT] Add worker efficiency cards to Pipeline dashboard | merged to main | 0m | success |
| 2026-02-24 | [FEAT] Add dark/light theme toggle to AdminLayout | merged to main | 6m | success |
| 2026-02-24 | [FEAT] Add task detail drawer to Tasks page | merged to main | 7m | success |
| 2026-02-24 | [FEAT] Add task search and tag filter to Tasks page | merged to main | 2m | success |
| 2026-02-20 | [DATA] Emit canonical `failed_root_snapshot` and blockers-sync parity check after reconciliation | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [DATA] Emit canonical `failed_root_snapshot` parity payload after each reconciliation cycle | merged to main | 1m | success |
| 2026-02-20 | [DATA] Emit canonical failed-root snapshot and blockers parity telemetry per reconciliation cycle | merged to main | 2m | success |
| 2026-02-20 | [DATA] Execute one canonical failed-task cleanup pass and commit resulting state files | merged to main | 4m | success |
| 2026-02-20 | [DATA] Read watchdog reconciliation counters from snapshot in dashboard status handler | merged to main | 2m | success |
| 2026-02-20 | [DATA] Refresh `.dev/blockers.md` Active from canonical failed-root state after convergence tasks land | merged to main | 2m | fixed (attempt 2) |
| 2026-02-20 | [DATA] Refresh `.dev/blockers.md` Active from post-reconciliation canonical failed roots | merged to main | 2m | success |
| 2026-02-20 | [DATA] Refresh `.dev/blockers.md` Active from post-sweep canonical failed roots | merged to main | 2m | success |
| 2026-02-20 | [DATA] Refresh `.dev/blockers.md` Active from reconciled failed-root reality | merged to main | 1m | success |
| 2026-02-20 | [DATA] Refresh blocker state from canonical failed-root reality after reconciliation | merged to main | 3m | fixed (attempt 1) |
| 2026-02-20 | [DATA] Refresh blockers Active from canonical failed roots after stale-active supersede | merged to main | 2m | success |
| 2026-02-20 | [DATA] Refresh blockers Active from post-reconcile canonical roots only | merged to main | 3m | success |
| 2026-02-20 | [DATA] Run a second reconcile-only idempotence verification after the canonical sweep and record parity evidence | merged to main | 2m | success |
| 2026-02-20 | [DATA] Run one canonical failed-root reconciliation sweep and refresh blocker parity snapshot | merged to main | 1m | success |
| 2026-02-20 | [DATA] Run one canonical reconcile-only convergence sweep and refresh state files | merged to main | 1m | success |
| 2026-02-20 | [DATA] Surface `driver_low_fix_rate_mode` counters in status JSON outputs | merged to main | 4m | success |
| 2026-02-20 | [DATA] Surface auth-gate dispatch state in status APIs and CLI JSON | merged to main | 4m | success |
| 2026-02-20 | [DATA] Surface blocked-duplication convergence counters in status JSON | merged to main | 3m | success |
| 2026-02-20 | [DATA] Surface canonical active-root diagnostics in status JSON surfaces | merged to main | 0m | success |
| 2026-02-20 | [DATA] Surface failed-root convergence metrics in CLI `status --json` | merged to main | 0m | success |
| 2026-02-20 | [DATA] Surface failed-root convergence metrics in pipeline status API | merged to main | 3m | success |
| 2026-02-20 | [DATA] Surface failed-root convergence snapshot in CLI `status --json` from canonical parser output | merged to main | 2m | success |
| 2026-02-20 | [DATA] Surface failed-root convergence snapshot in CLI status JSON | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [DATA] Surface failed-root hash parity in CLI `status --json` from canonical files | merged to main | 1m | success |
| 2026-02-20 | [DATA] Surface failed-root hash parity in dashboard pipeline-status output | merged to main | 3m | fixed (attempt 1) |
| 2026-02-20 | [DATA] Surface parse-guard and fixing-root supersede counters in status JSON | merged to main | 1m | success |
| 2026-02-20 | [DATA] Surface retry-pressure diagnostics in pipeline status and CLI JSON | merged to main | 2m | success |
| 2026-02-20 | [DATA] Surface stale-active convergence counters in status surfaces | merged to main | 1m | success |
| 2026-02-20 | [DATA] Surface watchdog canonicalization-precedence counters in status JSON | merged to main | 7m | success |
| 2026-02-20 | [DOCS] Add README.md for `@ajioncorp/skynet` dashboard package | merged to main | 2m | success |
| 2026-02-20 | [DOCS] Add a concise “Mission Achieved / Hardening Phase” operator note to README | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [DOCS] Add hardening-phase operator runbook to README | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [DOCS] Add hardening-phase operator runbook to `README.md` | merged to main | 1m | success |
| 2026-02-20 | [DOCS] Add npm package README for @ajioncorp/skynet-cli | merged to main | 1m | success |
| 2026-02-20 | [DOCS] Update README CLI reference with run, watch, upgrade, and metrics commands | merged to main | 0m | success |
| 2026-02-20 | [DOCS] Update README.md and packages/cli/README.md CLI reference tables with missing commands | merged to main | 0m | success |
| 2026-02-20 | [DOCS] Update README.md with missing CLI commands, dashboard components, and config vars | merged to main | 1m | success |
| 2026-02-20 | [FEAT] Add EventsDashboard component and `/admin/events` page | merged to main | 4m | success |
| 2026-02-20 | [FEAT] Add `echo` agent plugin for pipeline dry-run testing | merged to main | 0m | success |
| 2026-02-20 | [FEAT] Add `skynet changelog` CLI command for release note generation | merged to main | 2m | success |
| 2026-02-20 | [FEAT] Add `skynet doctor --fix` auto-remediation mode | merged to main | 2m | success |
| 2026-02-20 | [FEAT] Add `skynet export` CLI command for pipeline state snapshot | merged to main | 1m | success |
| 2026-02-20 | [FEAT] Add `skynet import` CLI command for restoring pipeline state from snapshot | merged to main | 2m | success |
| 2026-02-20 | [FEAT] Add `skynet init --from-snapshot` to bootstrap from exported state | merged to main | 1m | success |
| 2026-02-20 | [FEAT] Add `skynet test-notify` CLI command for notification channel verification | merged to main | 7m | success |
| 2026-02-20 | [FEAT] Add `skynet validate` CLI command for pre-flight project validation | merged to main | 2m | success |
| 2026-02-20 | [FEAT] Add config auto-migration to detect and add new variables on upgrade | merged to main | 2m | success |
| 2026-02-20 | [FEAT] Add shell completions for bash and zsh | merged to main | 2m | success |
| 2026-02-20 | [FEAT] Wire emit_event() calls into dev-worker.sh, task-fixer.sh, and watchdog.sh | merged to main | 2m | success |
| 2026-02-20 | [FIX] Add `SKYNET_INSTALL_CMD` config variable for non-pnpm projects | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Add `SKYNET_INSTALL_CMD` support for non-pnpm projects | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Add `SKYNET_ONE_SHOT` and `SKYNET_ONE_SHOT_TASK` to config.ts KNOWN_VARS | merged to main | 0m | success |
| 2026-02-20 | [FIX] Add `SKYNET_WORKER_CONTEXT` and `SKYNET_WORKER_CONVENTIONS` as commented-out examples in config template | merged to main | 0m | success |
| 2026-02-20 | [FIX] Add `files` field and `prepublishOnly` script to dashboard package.json for correct npm publish | merged to main | 1m | fixed (attempt 3) |
| 2026-02-20 | [FIX] Add `git pull` before first merge attempt in dev-worker.sh and task-fixer.sh to reduce unnecessary conflicts | merged to main | 0m | true` between lines 588 and 590 (after `cd "$PROJECT_DIR"`, before the first `git merge`). Apply the same fix in `scripts/task-fixer.sh` before its merge attempt at line 445. Run `bash -n` on both files and `pnpm typecheck`. Criterion #3 (reliability — proactively prevent merge conflicts instead of recovering from them) |
| 2026-02-20 | [FIX] Add `tg` notification and `emit_event` when task-fixer escalates task to blocked | merged to main | 0m | success |
| 2026-02-20 | [FIX] Add `validate`, `changelog`, and `--from-snapshot` to completions.ts | merged to main | 0m | success |
| 2026-02-20 | [FIX] Add `worker` field to `EventEntry` interface and display in dashboard | merged to main | 2m | success |
| 2026-02-20 | [FIX] Add backlog mutex lock to CLI `add-task` and `reset-task` commands to prevent data corruption | merged to main | 2m | success |
| 2026-02-20 | [FIX] Add canonical failed-task reconciliation in watchdog | merged to main | 0m | success |
| 2026-02-20 | [FIX] Add merge retry with rebase to task-fixer.sh | merged to main | 1m | success |
| 2026-02-20 | [FIX] Add missing KNOWN_VARS entries for SKYNET_WORKER_CONTEXT, SKYNET_WORKER_CONVENTIONS, and SKYNET_WATCHDOG_INTERVAL | merged to main | 0m | success |
| 2026-02-20 | [FIX] Add missing handler and type exports to `packages/dashboard/src/index.ts` | merged to main | 1m | success |
| 2026-02-20 | [FIX] Align watchdog health score math with CLI/dashboard | merged to main | 2m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Cap pipeline-status handler `completed` array to last 50 entries | merged to main | 0m | success |
| 2026-02-20 | [FIX] Close blocked CLI helper DRY root for `readFile`/`isProcessRunning` | merged to main | 3m | fixed (attempt 3) |
| 2026-02-20 | [FIX] Close blocked Codex large-prompt reliability root with deterministic stdin-first + exit-code invariants | merged to main | 2m | success |
| 2026-02-20 | [FIX] Close blocked Codex prompt root with exact repro+guard test | merged to main | 2m | success |
| 2026-02-20 | [FIX] Close blocked backlog-parser DRY root without parser behavior drift | merged to main | 1m | success |
| 2026-02-20 | [FIX] Close blocked config parity root for one-shot/watchdog knobs | merged to main | 2m | success |
| 2026-02-20 | [FIX] Close blocked config parity root for watchdog/one-shot knobs | merged to main | 2m | success |
| 2026-02-20 | [FIX] Close blocked dashboard backlog-parser DRY root without behavior drift | merged to main | 1m | success |
| 2026-02-20 | [FIX] Close blocked pipeline-logs line-count optimization root with response-shape parity | merged to main | 1m | success |
| 2026-02-20 | [FIX] Close blocked pipeline-logs optimization root with response-shape parity | merged to main | 2m | success |
| 2026-02-20 | [FIX] Close canonical CLI helper DRY retry root with lock-compat parity | merged to main | 1m | success |
| 2026-02-20 | [FIX] Close canonical CLI helper DRY root for `readFile`/`isProcessRunning` without behavior drift | merged to main | 2m | success |
| 2026-02-20 | [FIX] Close canonical Codex large-prompt blocked root with stdin-first + exit-code invariants | merged to main | 2m | success |
| 2026-02-20 | [FIX] Close canonical config-parity blocked root for one-shot/watchdog knobs | merged to main | 2m | success |
| 2026-02-20 | [FIX] Complete CLI process/file helper DRY extraction with lock-compat coverage | merged to main | 1m | success |
| 2026-02-20 | [FIX] Complete Codex large-prompt reliability path | merged to main | 4m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Consolidate duplicate `PipelineStatus` and `MonitoringStatus` types | merged to main | 0m | success |
| 2026-02-20 | [FIX] Consolidate duplicate pending failed-task entries at write time in `task-fixer.sh` | merged to main | 2m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Consolidate duplicate port config variables `SKYNET_DEV_SERVER_PORT` and `SKYNET_DEV_PORT` | merged to main | 1m | success |
| 2026-02-20 | [FIX] Delete stale dev/* branches for all superseded failed tasks | merged to main | 0m | success |
| 2026-02-20 | [FIX] Drain stale `pending` retries in `failed-tasks.md` after supersede normalization lands | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Enforce duplicate-pending prevention at write-time in `task-fixer.sh` | merged to main | 1m | success |
| 2026-02-20 | [FIX] Extract backlog title/blockedBy parsing into one shared parser | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Extract duplicate `isProcessRunning` and `readFile` to shared CLI utils | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Finish Codex large-prompt path with exit-code preservation | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Finish Codex large-prompt reliability path | merged to main | 3m | fixed (attempt 3) |
| 2026-02-20 | [FIX] Finish backlog parser DRY extraction with behavior-parity tests | merged to main | 2m | success |
| 2026-02-20 | [FIX] Fix CI `lint-sh` job missing pnpm setup causing every shell lint run to fail | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix Node.js version prerequisite mismatch in README | merged to main | 0m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Fix TypeScript backlog mutex path missing dash separator | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix `_agent.sh` relative plugin path resolution breaking custom agents | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix `check-server-errors.sh` hardcoded log path breaking multi-worker server error scanning | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix `sed -n 'Ip'` GNU extension breaking `blockedBy` dependency parsing on macOS | *blockedBy: *\(.*\)$/\1/Ip'` uses the `I` (case-insensitive) flag which is a GNU sed extension NOT available in macOS BSD sed. On macOS (the primary target platform), `blocked_by` is always empty, meaning `is_task_blocked()` never detects blocked tasks — workers attempt blocked tasks immediately, wasting cycles and producing incorrect results. Same issue in `scripts/_config.sh` line 231 inside `validate_backlog()`. Fix: replace `sed -n 's/.* | 0m | *blockedBy: *\(.*\)$/\1/Ip'` with `sed -n 's/.* |
| 2026-02-20 | [FIX] Fix `skynet logs` column header using unsupported printf format specifiers | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix `skynet stop` and `skynet doctor` hardcoded worker lists | merged to main | 1m | success |
| 2026-02-20 | [FIX] Fix `sync-runner.sh` pre-flight check using non-existent API route | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix dashboard typecheck | merged to main | 12m | success |
| 2026-02-20 | [FIX] Fix duplicate Activity icon for events page in admin navigation | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix dynamic Tailwind class names getting purged in production PipelineDashboard | merged to main | 1m | success |
| 2026-02-20 | [FIX] Fix health-check.sh lock path using `$SCRIPTS_DIR` instead of `$SKYNET_LOCK_PREFIX` | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix health-check.sh unquoted `$SKYNET_LINT_CMD` causing word splitting | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix is_task_blocked() to also check completed.md for dependency resolution | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix pipeline-status.ts `handlerCount` always returning 0 in production builds | merged to main | 0m | f.endsWith(".js")` and exclude both `.test.ts` and `.test.js`. Alternatively, hardcode the handler count as a known constant (currently 10 handlers) since it changes rarely and counting compiled files is inherently fragile. Run `pnpm typecheck` and `pnpm build` to verify. Criterion #4 (dashboard shows correct mission progress in production) |
| 2026-02-20 | [FIX] Fix project-driver deduplication to include completed.md and `[x]` backlog entries | ' 'NR>2 {t=$3; gsub(/^ + | 0m | +$/,"",t); if(t!="") print "- [ ] " t}' "$COMPLETED" >> "$_dedup_snapshot"; while IFS= read -r _line; do _normalize_task_line "$_line"; done < <(tail -n +3 "$_dedup_snapshot") >> "$_dedup_normalized"; fi`. This ensures tasks already in completed.md are never regenerated. Run `pnpm typecheck`. Criterion #3 (no wasted cycles — this single bug wasted ~30% of all API credits) |
| 2026-02-20 | [FIX] Fix stale lock recovery using wrong backlog marker causing 0m re-executions | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix sync-runner.sh bash 3.2 array syntax incompatibility | merged to main | 1m | success |
| 2026-02-20 | [FIX] Fix task POST handler to retry lock acquisition instead of immediate 423 failure | merged to main | 0m | success |
| 2026-02-20 | [FIX] Fix watchdog `_archive_old_completions` date comparison using `<` in `[ ]` | sort | 0m | head -1)" = "$entry_date" ]` and `[ "$entry_date" != "$cutoff_date" ]`. Run `bash -n scripts/watchdog.sh` and `pnpm typecheck`. Criterion #1 (portability — bash 3.2 on macOS) |
| 2026-02-20 | [FIX] Fix watchdog zombie detection to check heartbeat before killing alive workers | merged to main | 1m | success |
| 2026-02-20 | [FIX] Fix worker-scaling handler using `unlinkSync` on directory-based lock files | merged to main | 0m | success |
| 2026-02-20 | [FIX] Guard `skynet init` against re-run silently overwriting existing `skynet.config.sh` | merged to main | 0m | success |
| 2026-02-20 | [FIX] Harden failed-task table parsing for legacy unescaped pipe rows | merged to main | 1m | success |
| 2026-02-20 | [FIX] Improve watchdog auto-supersede to catch stale failed-tasks with title variations | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Land canonical CLI helper DRY extraction for `readFile`/`isProcessRunning` | merged to main | 2m | success |
| 2026-02-20 | [FIX] Land canonical backlog-parser DRY extraction without behavior drift | merged to main | 2m | success |
| 2026-02-20 | [FIX] Land canonical pipeline-logs line-count optimization with strict response parity | merged to main | 2m | success |
| 2026-02-20 | [FIX] Make LogViewer worker/fixer count dynamic instead of hardcoded | merged to main | 3m | success |
| 2026-02-20 | [FIX] Make failed-task markdown row writes pipe-safe across writers | ` in task/error/branch fields so `.dev/failed-tasks.md` remains parse-stable and row corruption cannot create phantom duplicates. Mission: Criterion #3 deterministic state and Criterion #2 retry-loop reliability. | 0m | merged to main |
| 2026-02-20 | [FIX] Make pipeline-logs line counting optimization pass typecheck | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Make stale heartbeat threshold config-consistent everywhere | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Make start-dev.sh accept worker ID for per-worker log and PID file isolation | merged to main | 1m | success |
| 2026-02-20 | [FIX] Make worker-scaling handler read `SKYNET_MAX_FIXERS` from config instead of hardcoding 3 | merged to main | 2m | success |
| 2026-02-20 | [FIX] Migrate sync-runner.sh, feature-validator.sh, and ui-tester.sh to mkdir-based atomic PID locks | merged to main | 0m | { ... check stale ... exit 0; }; echo $$ > "$LOCKFILE/pid"`. Update each cleanup trap from `rm -f "$LOCKFILE"` to `rm -rf "$LOCKFILE"`. Follow the exact pattern in `scripts/health-check.sh` lines 17-32 (which already uses mkdir). Run `bash -n scripts/sync-runner.sh scripts/feature-validator.sh scripts/ui-tester.sh` and `pnpm typecheck`. Criterion #3 (no race conditions — consistent locking across all scripts) |
| 2026-02-20 | [FIX] Migrate task-fixer.sh and project-driver.sh to mkdir-based atomic PID locks | merged to main | 0m | { ... }; echo $$ > "$LOCKFILE/pid"`. Update `cleanup_on_exit` at line 155 from `rm -f "$LOCKFILE"` to `rm -rf "$LOCKFILE"`. (2) Apply the same pattern to `project-driver.sh` lines 26-31 and its cleanup. (3) In `dev-worker.sh` line 395, update the project-driver lock check from `cat "${SKYNET_LOCK_PREFIX}-project-driver.lock"` to `cat "${SKYNET_LOCK_PREFIX}-project-driver.lock/pid"` since the lock is now a directory. Run `pnpm typecheck` and `bash -n scripts/task-fixer.sh scripts/project-driver.sh`. Criterion #3 (no race conditions — prevents duplicate fixer/driver instances) |
| 2026-02-20 | [FIX] Move health alert sentinel from `.dev/` to `/tmp/` | merged to main | 0m | success |
| 2026-02-20 | [FIX] Optimize pipeline logs line counting without full string split | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Pass agent prompt via stdin instead of CLI argument to avoid ARG_MAX | _agent_exec $SKYNET_CLAUDE_BIN $SKYNET_CLAUDE_FLAGS --print -` or write to a temp file and pass via `cat`. Check the `_agent_exec` function in `scripts/_agent.sh` to ensure stdin piping is compatible. If using a temp file, ensure it's cleaned up in the trap handler. Test with a large prompt string (>500KB) to verify. Run `pnpm typecheck`. Criterion #3 (reliability — prevents silent failures on large projects with extensive conventions) | 0m | merged to main |
| 2026-02-20 | [FIX] Patch shell injection risk in `skynet config set` | merged to main | 1m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Prevent duplicate pending failed rows at write-time in `scripts/task-fixer.sh` | merged to main | 2m | success |
| 2026-02-20 | [FIX] Prevent duplicate pending rows at write time in `scripts/task-fixer.sh` | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Re-open Codex large-prompt reliability path | merged to main | 3m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Re-open `skynet config set` shell injection fix | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Re-open duplicate pending write prevention in `scripts/task-fixer.sh` | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Re-open failed-task normalization and supersede sweep | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Re-open stale-threshold parity across CLI/dashboard/watchdog | merged to main | 4m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Read CLI version from package.json instead of hardcoding "0.1.0" | merged to main | 1m | success |
| 2026-02-20 | [FIX] Read `SKYNET_STALE_MINUTES` from config in `status.ts`, `watch.ts`, and `pipeline-status.ts` instead of hardcoding 45 | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Read `SKYNET_STALE_MINUTES` from config in pipeline-status handler and CLI status instead of hardcoding 45 | merged to main | 2m | fixed (attempt 2) |
| 2026-02-20 | [FIX] Remove any remaining shell-execution path from `skynet config set` | merged to main | 2m | success |
| 2026-02-20 | [FIX] Remove duplicate `_cleanup_stale_branches` function in watchdog.sh | superseded | 0m | blocked statuses, deletes local+remote branches for all resolved failed tasks) and again at line ~503 (only handles blocked entries with 24h+ age check against blockers.md). The first definition runs at line ~487 and already comprehensively handles ALL resolved statuses including blocked. The second definition at ~503 silently redefines the function, then runs at ~570 doing redundant work (blocked branches were already deleted by the first call). Fix: delete the second function definition — remove the comment block starting with `# --- Stale branch cleanup for permanently failed tasks ---` (line ~500) through the closing brace (line ~567), and delete its invocation `_cleanup_stale_branches` at line ~570. Also remove the `cd "$PROJECT_DIR"` line just before it (line ~569) since it's only needed by the second call. The first, comprehensive version already covers all cases. This is a real bug from two separate tasks being merged independently. Run `pnpm typecheck` to verify no breakage. Criterion #3 (clean code, no redundant logic) |
| 2026-02-20 | [FIX] Remove ghost `SKYNET_START_DEV_CMD` from config.ts KNOWN_VARS | merged to main | 0m | success |
| 2026-02-20 | [FIX] Remove shell-eval injection path from `skynet config set` | merged to main | 1m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Remove shell-execution path from `skynet config set` | merged to main | 2m | success |
| 2026-02-20 | [FIX] Replace `&>/dev/null` bashism with portable `>/dev/null 2>&1` in 8 script locations | merged to main | 1m | success |
| 2026-02-20 | [FIX] Replace `[[` with `case` in watchdog.sh for bash 3.2 style consistency | merged to main | 0m | continue`. While `[[` technically works in bash 3.2, the project's shell rules state bash 3.2 compatibility and the rest of the codebase uses `[ ... ]` exclusively. This is the only `[[` usage in the pipeline scripts (except `_compat.sh` for platform detection). Fix: replace with a `case` statement: `case "$branch" in dev/*) ;; *) continue ;; esac`. Run `bash -n scripts/watchdog.sh` and `pnpm typecheck` to verify. Criterion #1 (portability — consistent bash 3.2 style across all scripts) |
| 2026-02-20 | [FIX] Restore config template parity for one-shot/watchdog vars from canonical repro | merged to main | 2m | success |
| 2026-02-20 | [FIX] Restore config template parity for watchdog and one-shot knobs | merged to main | 1m | success |
| 2026-02-20 | [FIX] Restore config template parity for watchdog/one-shot knobs | merged to main | 1m | success |
| 2026-02-20 | [FIX] Restore project-driver backlog ordering convergence when checked rows appear above claims | merged to main | 1m | success |
| 2026-02-20 | [FIX] Run canonical failed-task reconciliation and one-time cleanup sweep | merged to main | 2m | success |
| 2026-02-20 | [FIX] Run one-time failed-task normalization and supersede sweep | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Stabilize Codex large-prompt path with deterministic exit-code preservation | merged to main | 3m | success |
| 2026-02-20 | [FIX] Supersede 21 stale `pending` entries in `failed-tasks.md` for already-completed tasks | merged to main | 2m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Throttle net-new task generation when retry queue is overloaded | merged to main | 1m | success |
| 2026-02-20 | [FIX] Truncate completed.md to last 30 entries in project-driver.sh prompt context | merged to main | 1m | success |
| 2026-02-20 | [FIX] Unblock CLI shared helper DRY root for `readFile`/`isProcessRunning` | merged to main | 1m | success |
| 2026-02-20 | [FIX] Unblock Codex large-prompt reliability root (canonical) | merged to main | 3m | success |
| 2026-02-20 | [FIX] Unblock Codex large-prompt reliability root with stdin-first invariants | merged to main | 2m | success |
| 2026-02-20 | [FIX] Unblock Codex large-prompt stdin/exit-code reliability from canonical repro | merged to main | 2m | success |
| 2026-02-20 | [FIX] Unblock config template parity root for one-shot/watchdog vars | merged to main | 1m | success |
| 2026-02-20 | [FIX] Unblock dashboard backlog-parser DRY extraction root | merged to main | 1m | success |
| 2026-02-20 | [FIX] Unblock pipeline-logs buffer line-count optimization root | merged to main | 1m | success |
| 2026-02-20 | [FIX] Unblock pipeline-logs buffer line-count optimization root with response-shape parity | merged to main | 3m | success |
| 2026-02-20 | [FIX] Unify stale-threshold and health-score math across CLI/dashboard/watchdog | merged to main | 4m | fixed (attempt 3) |
| 2026-02-20 | [FIX] Unify stale-threshold and health-score parity across CLI/dashboard/watchdog | merged to main | 3m | success |
| 2026-02-20 | [FIX] Unify stale-threshold config usage across CLI + dashboard + watchdog math | merged to main | 4m | fixed (attempt 1) |
| 2026-02-20 | [FIX] Update config.ts KNOWN_VARS dictionary with missing config variable descriptions | merged to main | 0m | success |
| 2026-02-20 | [FIX] Use `sed_inplace` wrapper in task-fixer.sh instead of raw `sed -i.bak` | fixing-${FIXER_ID} | 0m | / |
| 2026-02-20 | [FIX] Use configurable `SKYNET_AUTH_NOTIFY_INTERVAL` in auth-check.sh instead of hardcoded value | merged to main | 1m | success |
| 2026-02-20 | [FIX] Use mkdir-based atomic lock for watchdog PID singleton enforcement | merged to main | 6m | success |
| 2026-02-20 | [FIX] Validate git repository during `skynet init` | merged to main | 0m | success |
| 2026-02-20 | [INFRA] Add CI job dependency chain to save GitHub Actions minutes | merged to main | 0m | success |
| 2026-02-20 | [INFRA] Add Playwright E2E tests for events, logs, settings, and workers admin pages | merged to main | 2m | success |
| 2026-02-20 | [INFRA] Add SSE auto-reconnection with backoff to PipelineDashboard | 'reconnecting' | 0m | 'disconnected') displayed as a small colored indicator (green/yellow/red dot) next to the page title, (d) handle `document.visibilitychange` — close SSE when tab is hidden, reopen when visible to save server resources. Keep the existing polling fallback intact for browsers that don't support SSE. Criterion #4 (reliable real-time dashboard visibility) |
| 2026-02-20 | [INFRA] Add `permissions: contents: read` to CI workflow and npm metadata to published packages | merged to main | 1m | success |
| 2026-02-20 | [INFRA] Add `pnpm install --frozen-lockfile` to worker flow before typecheck | merged to main | 1m | success |
| 2026-02-20 | [INFRA] Add `timeout-minutes` to all CI workflow jobs to prevent runaway builds | merged to main | 0m | success |
