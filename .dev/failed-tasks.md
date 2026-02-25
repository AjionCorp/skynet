# Failed Tasks

| Date | Task | Branch | Error | Attempts | Status |
|------|------|--------|-------|----------|--------|
| 2026-02-25 | [INFRA] Harden worktree lifecycle to prevent "worktree missing before gates" failures | dev/harden-worktree-lifecycle-to-prevent-wor | merge conflict | 0 | failed |
| 2026-02-25 | [FIX] Strip duplicate tag prefixes from project-driver task title reconciliation | dev/strip-duplicate-tag-prefixes-from-projec | merge conflict | 0 | failed |
| 2026-02-25 | [TEST] Add standalone unit tests for `_worktree.sh` setup, cleanup, and stale detection | dev/add-standalone-unit-tests-for-worktreesh | typecheck failed | 0 | failed |
| 2026-02-25 | [TEST] Add standalone unit tests for `_agent.sh` agent dispatch, timeout, and fallback selection | dev/add-standalone-unit-tests-for-agentsh-ag | worktree missing before gates | 0 | failed |
| 2026-02-25 | [INFRA] Add watchdog stale-claim recovery to unclaim abandoned [>] backlog markers | dev/backlog-markers | worktree missing before gates | 0 | failed |
| 2026-02-25 | [FIX] Separate `rate_limits` write path from read-only DB access | dev/separate-ratelimits-write-path-from-read | merge conflict | 0 | failed |
| 2026-02-25 | [FIX] [FIX] Separate `rate_limits` write path from read-only DB access | dev/separate-ratelimits-write-path-from-read | typecheck failed | 0 | failed |
| 2026-02-25 | [INFRA] [INFRA] Complete echo agent dry-run lifecycle in `scripts/agents/echo.sh` | dev/complete-echo-agent-dry-run-lifecycle-in | worktree missing before gates | 0 | failed |
| 2026-02-25 | [TEST] [TEST] Add unit tests for `_config.sh` shared infrastructure helpers | dev/add-unit-tests-for-configsh-shared-infra | typecheck failed post-merge | 0 | failed |
| 2026-02-25 | [DATA] [DATA] Refresh `.dev/blockers.md` active status from canonical state and add mission-achieved celebration block | dev/refresh-devblockersmd-active-status-from | merge conflict | 0 | failed |
| 2026-02-25 | [INFRA] [INFRA] Auto-supersede stale `status=failed` rows when canonical root is already merged | dev/auto-supersede-stale-statusfailed-rows-w | merge conflict | 0 | failed |
| 2026-02-25 | [TEST] [TEST] Add init/setup-agents end-to-end regression for zero-to-autonomy bootstrap | dev/add-initsetup-agents-end-to-end-regressi | typecheck failed | 0 | failed |
| 2026-02-24 | [TEST] Add unit tests for _merge.sh shared merge-to-main logic | dev/add-unit-tests-for-mergesh-shared-merge- | claude exit code 1 | 0 | failed |
| 2026-02-24 | [TEST] Add unit tests for _config.sh shared infrastructure helpers | dev/add-unit-tests-for-configsh-shared-infra | claude exit code 1 | 0 | failed |
| 2026-02-24 | [TEST] Add integration test for watchdog crash recovery end-to-end | dev/add-integration-test-for-watchdog-crash- | claude exit code 1 | 0 | failed |
| 2026-02-24 | [INFRA] Add pipeline idle detection and completion signaling to watchdog | dev/add-pipeline-idle-detection-and-completi | claude exit code 1 | 0 | failed |
| 2026-02-24 | [TEST] Add handler unit tests for mission-raw and pipeline-stream | dev/add-handler-unit-tests-for-mission-raw-a | typecheck failed | 0 | failed |
| 2026-02-24 | [INFRA] Add prompt size guardrail before LLM agent invocation | dev/add-prompt-size-guardrail-before-llm-age | merge conflict | 0 | failed |
| 2026-02-24 | [INFRA] Sync backlog.md claimed markers with DB state during watchdog reconciliation | dev/sync-backlogmd-claimed-markers-with-db-s | worktree missing before gates | 0 | failed |
| 2026-02-24 | [TEST] Add unit tests for _locks.sh atomic locking and merge mutex | dev/add-unit-tests-for-lockssh-atomic-lockin | typecheck failed | 0 | failed |
| 2026-02-24 | [FIX] Separate rate_limits write path from read-only DB access | dev/separate-ratelimits-write-path-from-read | worktree missing before gates | 0 | failed |
| 2026-02-24 | [INFRA] Complete echo agent dry-run lifecycle in scripts/agents/echo.sh | dev/complete-echo-agent-dry-run-lifecycle-in | typecheck failed | 0 | failed |
| 2026-02-24 | [DATA] Refresh blockers.md Active section to match current resolved state | dev/refresh-blockersmd-active-section-to-mat | merge conflict | 0 | failed |
| 2026-02-24 | [FEAT] Add pipeline health trend sparkline to Pipeline dashboard | dev/add-pipeline-health-trend-sparkline-to-p | merge conflict | 0 | failed |
| 2026-02-24 | [FEAT] Add keyboard shortcuts to dashboard | dev/add-keyboard-shortcuts-to-dashboard | worktree missing before gates | 0 | failed |
| 2026-02-24 | [FEAT] Add task completion velocity chart to Pipeline dashboard | dev/add-task-completion-velocity-chart-to-pi | critical merge failure | 0 | failed |
| 2026-02-24 | [FEAT] Add worker efficiency cards to Pipeline dashboard | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [TEST] Add EventsDashboard component tests | merged to main | merge conflict | 1 | fixed |
| 2026-02-20 | [FIX] Fix codex.sh to pipe prompt via stdin instead of CLI argument | fix/fix-codexsh-to-pipe-prompt-via-stdin-ins | typecheck failed after fix attempt 3 | 3 | fixed |
| 2026-02-20 | [FIX] Add missing `SKYNET_WATCHDOG_INTERVAL` and `SKYNET_ONE_SHOT` to config template | dev/add-missing-skynetwatchdoginterval-and-s | typecheck failed (fix attempt 1 failed) (fix attempt 2 failed) (fix attempt 3 failed) | 3 | fixed |
| 2026-02-20 | [TEST] Add E2E tests for `skynet stop`, `skynet pause`/`resume`, and remaining CLI smoke tests | dev/add-e2e-tests-for-skynet-stop-skynet-pau | typecheck failed after fix attempt 3 | 3 | fixed |
| 2026-02-20 | [FIX] Optimize pipeline-logs handler to avoid reading entire file for line count | dev/-10-totallines--totallines-this-counts-n | typecheck failed after fix attempt 3 | 3 | fixed |
| 2026-02-20 | [FIX] Extract duplicate `extractTitle` and `parseBlockedBy` to shared backlog-parser module | fix/extract-duplicate-extracttitle-and-parse | typecheck failed after fix attempt 2 (fix attempt 3 failed) | 3 | fixed |
| 2026-02-20 | [FIX] Extract duplicate `isProcessRunning` and `readFile` utilities to shared CLI module | fix/extract-duplicate-isprocessrunning-and-r | typecheck failed after fix attempt 3 | 3 | fixed |
| 2026-02-20 | [FIX] Improve watchdog auto-supersede to catch stale failed-tasks with title variations | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Improve watchdog auto-supersede to catch stale failed-tasks with title variations | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Add `files` field and `prepublishOnly` script to dashboard package.json for correct npm publish | merged to main | typecheck failed after fix attempt 2 | 3 | fixed |
| 2026-02-20 | [FIX] Read `SKYNET_STALE_MINUTES` from config in pipeline-status handler and CLI status instead of hardcoding 45 | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Add `SKYNET_INSTALL_CMD` config variable for non-pnpm projects | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Fix Node.js version prerequisite mismatch in README | merged to main | claude exit code 1 | 1 | fixed |
| 2026-02-20 | [FIX] Read `SKYNET_STALE_MINUTES` from config in pipeline-status handler and CLI status instead of hardcoding 45 | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Fix Node.js version prerequisite mismatch in README | merged to main | claude exit code 1 | 1 | fixed |
| 2026-02-20 | [FIX] Supersede 21 stale `pending` entries in `failed-tasks.md` for already-completed tasks | merged to main | claude exit code 1 | 1 | fixed |
| 2026-02-20 | [FIX] Read `SKYNET_STALE_MINUTES` from config in `status.ts`, `watch.ts`, and `pipeline-status.ts` instead of hardcoding 45 | merged to main | 45; const staleThresholdMs = staleMinutes * 60 * 1000;` where `vars` comes from `loadConfig()`. In `pipeline-status.ts`, read the config file and extract `SKYNET_STALE_MINUTES` similarly. Run `pnpm typecheck`. Criterion #3 (consistent behavior — all components must honor configuration) | 1 | fixed |
| 2026-02-20 | [INFRA] Commit and verify orphaned `main` working-tree fixes from killed workers | merged to main | claude exit code 1 | 1 | fixed |
| 2026-02-20 | [FIX] Patch shell injection risk in `skynet config set` | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Make stale heartbeat threshold config-consistent everywhere | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Align watchdog health score math with CLI/dashboard | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Drain stale `pending` retries in `failed-tasks.md` after supersede normalization lands | merged to main | claude exit code 1 | 1 | fixed |
| 2026-02-20 | [FIX] Finish Codex large-prompt reliability path | merged to main | typecheck failed after fix attempt 2 | 3 | fixed |
| 2026-02-20 | [TEST] Add regression coverage for stale-threshold + health-score parity | merged to main | claude exit code 1 | 1 | fixed |
| 2026-02-20 | [FIX] Consolidate duplicate pending failed-task entries at write time in `task-fixer.sh` | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [INFRA] Add project-driver guardrail when backlog is empty but retries exist | merged to main | claude exit code 1 | 1 | fixed |
| 2026-02-20 | [DOCS] Add a concise “Mission Achieved / Hardening Phase” operator note to README | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [INFRA] Land orphaned main working-tree fixes with clean commits | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Remove shell-eval injection path from `skynet config set` | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Unify stale-threshold config usage across CLI + dashboard + watchdog math | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Remove shell-eval injection path from `skynet config set` | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Unify stale-threshold config usage across CLI + dashboard + watchdog math | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Run one-time failed-task normalization and supersede sweep | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Run one-time failed-task normalization and supersede sweep | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Prevent duplicate pending rows at write time in `scripts/task-fixer.sh` | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Prevent duplicate pending rows at write time in `scripts/task-fixer.sh` | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Finish Codex large-prompt path with exit-code preservation | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add parity regression tests for stale threshold and health score | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [INFRA] Add backlog-empty recovery generation in `scripts/project-driver.sh` | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [INFRA] Re-open hardening commit sweep on `main` | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Re-open stale-threshold parity across CLI/dashboard/watchdog | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Re-open `skynet config set` shell injection fix | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Re-open duplicate pending write prevention in `scripts/task-fixer.sh` | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Re-open failed-task normalization and supersede sweep | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Re-open failed-task normalization and supersede sweep | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Re-open `skynet config set` shell injection fix | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Re-open Codex large-prompt reliability path | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [TEST] Re-open parity regression coverage for stale-threshold and health-score math | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Unify stale-threshold and health-score math across CLI/dashboard/watchdog | merged to main | typecheck failed after fix attempt 2 | 3 | fixed |
| 2026-02-20 | [INFRA] Land orphaned `main` hardening changes with clean commit split | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [INFRA] Land orphaned `main` hardening changes with clean commit split | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Complete Codex large-prompt reliability path | merged to main | claude exit code 1 | 1 | fixed |
| 2026-02-20 | [TEST] Add parity regression coverage for stale-threshold + health-score alignment | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [TEST] Re-open CLI E2E smoke coverage for operational commands | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [INFRA] Add project-driver recovery generation when backlog is empty but retries exist | merged to main | typecheck failed after fix attempt 2 | 3 | fixed |
| 2026-02-20 | [DOCS] Add hardening-phase operator runbook to README | merged to main | claude exit code 1 | 1 | fixed |
| 2026-02-20 | [NMI] Triage blocked retries with failed 3-attempt loops | merged to main | claude exit code 1 | 1 | fixed |
| 2026-02-20 | [INFRA] Land orphaned `main` hardening sweep with coherent commits | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [INFRA] Run one-time failed-task cleanup after reconciliation lands | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add stale-threshold and health-score parity regression coverage | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add stale-threshold and health-score parity regression coverage | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Re-open CLI operational E2E smoke coverage | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Optimize pipeline logs line counting without full string split | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [INFRA] Land orphaned `main` hardening changes with atomic commits | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [FIX] Extract duplicate `isProcessRunning` and `readFile` to shared CLI utils | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Extract duplicate `isProcessRunning` and `readFile` to shared CLI utils | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [NMI] Triage blocked 3-attempt retry loops into minimal follow-ups | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Add `SKYNET_INSTALL_CMD` support for non-pnpm projects | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [NMI] Triage blocked 3-attempt retry loops into minimal reproducible follow-ups | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Extract backlog title/blockedBy parsing into one shared parser | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Make pipeline-logs line counting optimization pass typecheck | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [INFRA] Harden project-driver canonicalization rules in `scripts/project-driver.sh` prompt | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add regression coverage for failed-task canonicalization invariants | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [INFRA] Enforce canonical failed-task convergence before fixer dispatch | merged to main | blocked`) in `.dev/failed-tasks.md`, supersedes duplicates, and emits per-root reconciliation counts. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state. | 1 | fixed |
| 2026-02-20 | [INFRA] Canonicalize active failed-task roots and collapse duplicate pending variants | merged to main | blocked`) in `.dev/failed-tasks.md`, supersede all duplicate variants, and log before/after root counts. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state. | 1 | fixed |
| 2026-02-20 | [TEST] Add regression coverage for failed-task canonicalization invariants | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add regression coverage for failed-task canonicalization invariants | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [INFRA] Canonicalize active failed-task roots and collapse duplicate variants | merged to main | blocked`), supersede redundant variants, and emit before/after root counts to logs/events. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state. | 1 | fixed |
| 2026-02-20 | [INFRA] Canonicalize active failed-task roots and collapse duplicate variants | merged to main | blocked`), supersede redundant variants, and emit before/after root counts to logs/events. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state. | 1 | fixed |
| 2026-02-20 | [INFRA] Reduce project-driver prompt bloat from backlog history | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [INFRA] Reduce project-driver prompt bloat from backlog history | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [FIX] Close blocked CLI helper DRY root for `readFile`/`isProcessRunning` | merged to main | typecheck failed (fix attempt 1 failed) (fix attempt 2 failed) | 3 | fixed |
| 2026-02-20 | [FIX] Close blocked CLI helper DRY root for `readFile`/`isProcessRunning` | merged to main | typecheck failed (fix attempt 1 failed) (fix attempt 2 failed) | 3 | fixed |
| 2026-02-20 | [DATA] Refresh blocker state from canonical failed-root reality after reconciliation | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [DATA] Refresh blocker state from canonical failed-root reality after reconciliation | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [DATA] Surface failed-root convergence snapshot in CLI status JSON | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [DATA] Refresh `.dev/blockers.md` Active from canonical failed-root state after convergence tasks land | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [INFRA] Add failed-task history rotation guardrail to keep fixer context bounded | merged to main | fixing-* | 1 | fixed |
| 2026-02-20 | [TEST] Add watchdog regression for blocked-row supersede guardrails | merged to main | dev/add-watchdog-regression-for-blocked-row- | 1 | fixed |
| 2026-02-20 | [TEST] Add project-driver regression to suppress task generation for stale-active completed roots | merged to main | dev/add-project-driver-regression-to-suppres | 1 | fixed |
| 2026-02-20 | [NMI] Publish canonical diagnostics only for truly remaining active roots after cleanup | merged to main | dev/publish-canonical-diagnostics-only-for-t | 1 | fixed |
| 2026-02-20 | [DATA] Emit canonical `failed_root_snapshot` and blockers-sync parity check after reconciliation | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add shell regression for watchdog reconcile-only mode idempotence | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add shell regression for watchdog reconcile-only mode idempotence | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [DATA] Surface failed-root hash parity in dashboard pipeline-status output | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add watchdog shell regression for failed-root hash-drift alert throttling lifecycle | merged to main | typecheck failed after fix attempt 1 | 2 | fixed |
| 2026-02-20 | [TEST] Add shell regression for auth-expiry dispatch suppression and recovery | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [INFRA] Run one canonical stale-active root supersede sweep for current blocked/pending drift | merged to main | dev/run-one-canonical-stale-active-root-supe | 1 | fixed |
| 2026-02-20 | [NMI] Publish canonical diagnostics only for truly remaining active roots after cleanup | merged to main | dev/publish-canonical-diagnostics-only-for-t | 1 | fixed |
| 2026-02-20 | [INFRA] Add failed-task history rotation guardrail to bound fixer context size | merged to main | dev/add-failed-task-history-rotation-guardra | 1 | fixed |
| 2026-02-20 | [INFRA] Centralize failed-task markdown field codec into shared shell helpers | merged to main | dev/centralize-failed-task-markdown-field-co | 1 | fixed |
| 2026-02-20 | [TEST] Add regression coverage for shared failed-task field codec round-trip invariants | merged to main | dev/add-regression-coverage-for-shared-faile | 1 | fixed |
| 2026-02-20 | [NMI] Publish one canonical blocked-root diagnostics row per true open root | merged to main | dev/publish-one-canonical-blocked-root-diagn | 1 | fixed |
| 2026-02-20 | [TEST] Add watchdog shell regression for hash-drift alert throttling lifecycle | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add watchdog regression for stale blocked/pending supersede guardrails | merged to main | dev/add-watchdog-regression-for-stale-blocke | 1 | fixed |
| 2026-02-20 | [TEST] Add watchdog regression for deterministic stale-active sweep evidence | merged to main | fixing-*` rows where only completed-root stale active rows are superseded, unaffected rows remain byte-identical, and emitted counters/hash summary are stable across two identical runs. Mission: Criterion #2 quality gates and Criterion #3 deterministic recovery. | 1 | fixed |
| 2026-02-20 | [TEST] Add regression for failed-task history compaction invariants | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add regression for failed-task history compaction invariants | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [INFRA] Add low-fix-rate generation mode to project-driver prompting | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [INFRA] Add low-fix-rate generation mode to project-driver prompting | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add shell regression for project-driver telemetry snapshot determinism | merged to main | typecheck failed | 1 | fixed |
| 2026-02-20 | [TEST] Add cross-script regression for shared failed-root normalization parity | merged to main | claude exit code 1 | 1 | fixed |
| 2026-02-19 | [FEAT] Add `skynet start` and `skynet stop` CLI commands | merged to main | playwright tests failed | 1 | fixed |
| 2026-02-19 | [FEAT] Add crash recovery to watchdog | merged to main | playwright tests failed (fix attempt 1 failed) | 2 | fixed |
| 2026-02-19 | [INFRA] Add npm package build and publish workflow | merged to main | playwright tests failed | 1 | fixed |
| 2026-02-19 | [TEST] Add unit tests for shell script lock acquisition and task claiming | merged to main | playwright tests failed | 1 | fixed |
| 2026-02-19 | [TEST] Add TypeScript tests for API handlers | merged to main | playwright tests failed | 1 | fixed |
| 2026-02-19 | [FEAT] Add mission progress tracking to project-driver | merged to main | playwright tests failed | 1 | fixed |
| 2026-02-19 | [FEAT] Add mission.md viewer tab to admin dashboard | merged to main | playwright tests failed | 1 | fixed |
| 2026-02-19 | [FIX] Fix watchdog crash_recovery and dispatch hardcoded worker IDs | merged to main | merge conflict | 1 | fixed |
| 2026-02-19 | [FEAT] Add mission viewer page to admin dashboard | merged to main | merge conflict | 1 | fixed |
| 2026-02-19 | [FEAT] Add `skynet pause` and `skynet resume` CLI commands for pipeline flow control | merged to main | merge conflict | 1 | fixed |
| 2026-02-19 | [FIX] Fix SKYNET_MAX_WORKERS default mismatch between config template and watchdog | merged to main | merge conflict | 1 | fixed |
| 2026-02-19 | [TEST] Add events handler unit tests and ActivityFeed component tests | merged to main | merge conflict | 1 | fixed |
| 2026-02-25 | [TEST] Add unit tests for `_locks.sh` atomic locking and merge mutex | dev/add-unit-tests-for-lockssh-atomic-lockin | merge conflict | 0 | superseded |
| 2026-02-20 | [FEAT] Add `echo` agent plugin for pipeline dry-run testing | dev/add-echo-agent-plugin-for-pipeline-dry-r | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Fix duplicate Activity icon for events page in admin navigation | dev/fix-duplicate-activity-icon-for-events-p | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add E2E tests for `skynet stop`, `skynet pause`/`resume`, and remaining CLI smoke tests | dev/add-e2e-tests-for-skynet-stop-skynet-pau | typecheck failed after fix attempt 3 | 3 | superseded |
| 2026-02-20 | [TEST] Add E2E tests for `skynet stop`, `skynet pause`/`resume`, and remaining CLI smoke tests | dev/add-e2e-tests-for-skynet-stop-skynet-pau | typecheck failed after fix attempt 3 | 3 | superseded |
| 2026-02-20 | [FIX] Extract duplicate `extractTitle` and `parseBlockedBy` to shared backlog-parser module | fix/extract-duplicate-extracttitle-and-parse | typecheck failed after fix attempt 2 (fix attempt 3 failed) | 3 | superseded |
| 2026-02-20 | [FIX] Extract duplicate `isProcessRunning` and `readFile` utilities to shared CLI module | fix/extract-duplicate-isprocessrunning-and-r | typecheck failed after fix attempt 3 | 3 | superseded |
| 2026-02-20 | [FIX] Extract duplicate `isProcessRunning` and `readFile` utilities to shared CLI module | fix/extract-duplicate-isprocessrunning-and-r | typecheck failed after fix attempt 3 | 3 | superseded |
| 2026-02-20 | [FIX] Fix dashboard typecheck | dev/fix-dashboard-typecheck--35-fetch-mock-t | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Extract duplicate `isProcessRunning` and `readFile` utilities to shared CLI module | fix/extract-duplicate-isprocessrunning-and-r | typecheck failed after fix attempt 3 | 3 | superseded |
| 2026-02-20 | [FIX] Extract duplicate `isProcessRunning` and `readFile` utilities to shared CLI module | fix/extract-duplicate-isprocessrunning-and-r | typecheck failed after fix attempt 3 | 3 | superseded |
| 2026-02-20 | [FIX] Fix task POST handler to retry lock acquisition instead of immediate 423 failure | dev/fix-task-post-handler-to-retry-lock-acqu | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Guard `skynet init` against re-run silently overwriting existing `skynet.config.sh` | dev/guard-skynet-init-against-re-run-silentl | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Fix dashboard typecheck | dev/fix-dashboard-typecheck--35-fetch-mock-t | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Remove shell-execution path from `skynet config set` | dev/remove-shell-execution-path-from-skynet- | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Add canonical failed-task reconciliation pass in watchdog | dev/add-canonical-failed-task-reconciliation | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Remove shell-execution path from `skynet config set` | dev/remove-shell-execution-path-from-skynet- | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Add canonical failed-task reconciliation pass in watchdog | dev/add-canonical-failed-task-reconciliation | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Prevent duplicate `pending` failed rows at write-time in `task-fixer.sh` | dev/prevent-duplicate-pending-failed-rows-at | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Prevent duplicate pending failed rows at write-time in `task-fixer.sh` | dev/prevent-duplicate-pending-failed-rows-at | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Prevent duplicate pending failed rows at write-time in `task-fixer.sh` | dev/prevent-duplicate-pending-failed-rows-at | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Restore config template parity for watchdog/one-shot knobs | dev/restore-config-template-parity-for-watch | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Add backlog-empty recovery generation in `scripts/project-driver.sh` | dev/add-backlog-empty-recovery-generation-in | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Prevent duplicate pending failed rows at write-time in `scripts/task-fixer.sh` | dev/prevent-duplicate-pending-failed-rows-at | typecheck failed | 0 | superseded |
| 2026-02-20 | [NMI] Triage blocked retries with failed 3-attempt loops | dev/triage-blocked-retries-with-failed-3-att | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Prevent duplicate pending failed rows at write-time in `scripts/task-fixer.sh` | dev/prevent-duplicate-pending-failed-rows-at | typecheck failed | 0 | superseded |
| 2026-02-20 | [NMI] Triage blocked retries with failed 3-attempt loops | dev/triage-blocked-retries-with-failed-3-att | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Land orphaned `main` hardening changes with atomic commits | dev/land-orphaned-main-hardening-changes-wit | claude exit code 1 | 0 | superseded |
| 2026-02-20 | [INFRA] Land orphaned `main` hardening changes with atomic commits | dev/land-orphaned-main-hardening-changes-wit | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Remove shell-execution path from `skynet config set` | dev/remove-shell-execution-path-from-skynet- | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unify stale-threshold and health-score math across CLI/dashboard/watchdog | dev/unify-stale-threshold-and-health-score-m | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unify stale-threshold and health-score math across CLI/dashboard/watchdog | dev/unify-stale-threshold-and-health-score-m | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add parity regression coverage for stale-threshold and health-score alignment | dev/add-parity-regression-coverage-for-stale | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Land orphaned `main` hardening changes with atomic commits | dev/land-orphaned-main-hardening-changes-wit | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Optimize pipeline logs line counting without full string split | dev/optimize-pipeline-logs-line-counting-wit | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Add canonical failed-task reconciliation in watchdog | dev/add-canonical-failed-task-reconciliation | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Optimize pipeline-logs line counting without full string split | dev/optimize-pipeline-logs-line-counting-wit | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unify stale-threshold and health-score parity across CLI/dashboard/watchdog | dev/unify-stale-threshold-and-health-score-p | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Enforce duplicate-pending prevention at write-time in `task-fixer.sh` | dev/enforce-duplicate-pending-prevention-at- | typecheck failed | 0 | superseded |
| 2026-02-20 | [NMI] Canonicalize blocked retry roots from `.dev/failed-tasks.md` | dev/canonicalize-blocked-retry-roots-from-de | claude exit code 1 | 0 | superseded |
| 2026-02-20 | [FIX] Stabilize Codex large-prompt path with deterministic exit-code preservation | dev/stabilize-codex-large-prompt-path-with-d | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Complete CLI process/file helper DRY extraction with lock-compat coverage | dev/complete-cli-processfile-helper-dry-extr | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Stabilize Codex large-prompt path with deterministic exit-code preservation | dev/stabilize-codex-large-prompt-path-with-d | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Execute one canonical failed-task cleanup pass after reconciliation | dev/execute-one-canonical-failed-task-cleanu | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Run one canonical failed-task reconciliation sweep and supersede duplicate retries | dev/run-one-canonical-failed-task-reconcilia | typecheck failed | 0 | superseded |
| 2026-02-20 | [NMI] Produce diagnostics bundle for blocked roots before requeue | dev/produce-diagnostics-bundle-for-blocked-r | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Stabilize Codex large-prompt path with deterministic exit-code preservation | dev/stabilize-codex-large-prompt-path-with-d | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unblock Codex large-prompt reliability root with stdin-first + exit-code invariants | dev/unblock-codex-large-prompt-reliability-r | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unblock Codex large-prompt reliability root with stdin-first + exit-code invariants | dev/unblock-codex-large-prompt-reliability-r | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unblock pipeline-logs buffer line-count optimization root | dev/unblock-pipeline-logs-buffer-line-count- | typecheck failed | 0 | superseded |
| 2026-02-20 | [NMI] Refresh blocked-root diagnostics snapshot to one canonical row per root cause | dev/refresh-blocked-root-diagnostics-snapsho | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Harden project-driver prompt/task postfilter for durable root-cause titles | dev/harden-project-driver-prompttask-postfil | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unblock Codex large-prompt reliability root (canonical) | dev/unblock-codex-large-prompt-reliability-r | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unblock CLI shared helper DRY root for `readFile`/`isProcessRunning` | dev/unblock-cli-shared-helper-dry-root-for-r | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unblock dashboard backlog-parser DRY extraction root | dev/unblock-dashboard-backlog-parser-dry-ext | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unblock pipeline-logs buffer line-count optimization root with response-shape parity | dev/unblock-pipeline-logs-buffer-line-count- | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Unblock CLI operational E2E smoke root in one canonical task | dev/unblock-cli-operational-e2e-smoke-root-i | typecheck failed | 0 | superseded |
| 2026-02-20 | [NMI] Publish canonical blocked-root repro matrix for top active roots | dev/publish-canonical-blocked-root-repro-mat | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Land canonical CLI helper DRY extraction for `readFile`/`isProcessRunning` | dev/land-canonical-cli-helper-dry-extraction | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Enforce continuous failed-task root convergence beyond one-time sweep | dev/enforce-continuous-failed-task-root-conv | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add regression coverage for failed-task convergence across `pending | fix/add-regression-coverage-for-failed-task- | typecheck failed after fix attempt 1 | 1 | superseded |
| 2026-02-20 | [FIX] Close blocked config parity root for one-shot/watchdog knobs | dev/close-blocked-config-parity-root-for-one | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Close blocked config parity root for one-shot/watchdog knobs | dev/close-blocked-config-parity-root-for-one | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Close blocked backlog-parser DRY root without parser behavior drift | dev/close-blocked-backlog-parser-dry-root-wi | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Close blocked pipeline-logs optimization root with response-shape parity | dev/close-blocked-pipeline-logs-optimization | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Prevent future duplicate retry variants at source in project-driver output filtering | dev/prevent-future-duplicate-retry-variants- | typecheck failed | 0 | superseded |
| 2026-02-20 | [DATA] Surface failed-root convergence metrics in pipeline status API | dev/surface-failed-root-convergence-metrics- | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Add retry-pressure mode in `scripts/project-driver.sh` when pending retries exceed threshold | dev/add-retry-pressure-mode-in-scriptsprojec | typecheck failed | 0 | superseded |
| 2026-02-20 | [NMI] Publish canonical blocked-root repro matrix from latest logs | dev/publish-canonical-blocked-root-repro-mat | typecheck failed | 0 | superseded |
| 2026-02-20 | [NMI] Resolve blocked-root state drift between `.dev/backlog.md` and `.dev/failed-tasks.md` | dev/resolve-blocked-root-state-drift-between | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Run one canonical failed-task compaction sweep for active roots | fix/run-one-canonical-failed-task-compaction | dev/run-one-canonical-failed-task-compaction (fix attempt 1 failed) | 1 | superseded |
| 2026-02-20 | [INFRA] Reconcile blocked/pending drift between failed-task and backlog state after fixer cycles | dev/reconcile-blockedpending-drift-between-f | claude exit code 1 | 0 | superseded |
| 2026-02-20 | [TEST] Add project-driver regression for backlog history rotation invariants | dev/add-project-driver-regression-for-backlo | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add project-driver regression for backlog history rotation invariants | dev/add-project-driver-regression-for-backlo | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add regression coverage for shared failed-task field codec round-trip invariants | fix/add-regression-coverage-for-shared-faile | typecheck failed after fix attempt 1 | 1 | superseded |
| 2026-02-20 | [INFRA] Centralize failed-task markdown escaping/unescaping into shared helpers and migrate all writers/parsers | fix/centralize-failed-task-markdown-escaping | typecheck failed after fix attempt 1 | 1 | superseded |
| 2026-02-20 | [INFRA] Add watchdog hash-drift pressure alerting with throttle guard | dev/add-watchdog-hash-drift-pressure-alertin | typecheck failed | 0 | superseded |
| 2026-02-20 | [DATA] Run a second reconcile-only idempotence verification after the canonical sweep and record parity evidence | dev/run-a-second-reconcile-only-idempotence- | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Add watchdog guardrail to suppress no-op blockers rewrites when active-root hash is unchanged | dev/add-watchdog-guardrail-to-suppress-no-op | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add cross-surface hash-parity regression fixtures for watchdog, dashboard, and CLI | dev/add-cross-surface-hash-parity-regression | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add watchdog regression for no-op blockers sync guardrail semantics | dev/add-watchdog-regression-for-no-op-blocke | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Enforce canonical backlog marker ordering before each dispatch cycle | dev/enforce-canonical-backlog-marker-orderin | typecheck failed | 0 | superseded |
| 2026-02-20 | [DATA] Execute one canonical failed-task cleanup pass and commit resulting state files | dev/execute-one-canonical-failed-task-cleanu | claude exit code 124 | 0 | superseded |
| 2026-02-20 | [FIX] Close blocked config parity root for watchdog/one-shot knobs | dev/close-blocked-config-parity-root-for-wat | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unblock Codex large-prompt reliability root with stdin-first invariants | dev/unblock-codex-large-prompt-reliability-r | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Unblock Codex large-prompt reliability root with stdin-first invariants | dev/unblock-codex-large-prompt-reliability-r | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Re-open CLI operational E2E smoke coverage as one canonical root | dev/re-open-cli-operational-e2e-smoke-covera | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add shell regression for reconcile-only idempotence with snapshot invariants | dev/add-shell-regression-for-reconcile-only- | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add shell regression for reconcile-only idempotence with snapshot invariants | dev/add-shell-regression-for-reconcile-only- | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add shell regression for reconcile-only idempotence with snapshot invariants | dev/add-shell-regression-for-reconcile-only- | typecheck failed | 0 | superseded |
| 2026-02-20 | [DATA] Surface failed-root hash parity in dashboard pipeline status output | dev/surface-failed-root-hash-parity-in-dashb | typecheck failed | 0 | superseded |
| 2026-02-20 | [DATA] Run one canonical failed-root reconciliation sweep and refresh blocker parity snapshot | dev/run-one-canonical-failed-root-reconcilia | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add shell regression for failed-task field codec round-trip invariants | dev/add-shell-regression-for-failed-task-fie | typecheck failed | 0 | superseded |
| 2026-02-20 | [FIX] Harden failed-task table parsing for legacy unescaped pipe rows | dev/harden-failed-task-table-parsing-for-leg | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Enforce active-root canonical row precedence (`fixing-*` > `blocked` > `pending`) in watchdog reconciliation | dev/enforce-active-root-canonical-row-preced | typecheck failed | 0 | superseded |
| 2026-02-20 | [TEST] Add cross-surface parity regression for stale-active counters and root-hash fields | dev/add-cross-surface-parity-regression-for- | typecheck failed | 0 | superseded |
| 2026-02-20 | [DATA] Surface canonical active-root diagnostics in status JSON surfaces | dev/surface-canonical-active-root-diagnostic | typecheck failed | 0 | superseded |
| 2026-02-20 | [DATA] Surface `driver_low_fix_rate_mode` counters in status JSON outputs | dev/surface-driverlowfixratemode-counters-in | typecheck failed | 0 | superseded |
| 2026-02-20 | [DATA] Surface `driver_low_fix_rate_mode` counters in status JSON outputs | dev/surface-driverlowfixratemode-counters-in | typecheck failed | 0 | superseded |
| 2026-02-20 | [INFRA] Centralize failed-task markdown field codec into shared shell helpers | dev/centralize-failed-task-markdown-field-co | worktree missing before gates | 0 | superseded |
| 2026-02-20 | [TEST] Add project-driver regression for unchecked-cap + ordering invariants | dev/add-project-driver-regression-for-unchec | worktree missing before gates | 0 | superseded |
| 2026-02-20 | [INFRA] Emit canonical watchdog reconciliation telemetry snapshot per cycle | dev/emit-canonical-watchdog-reconciliation-t | worktree missing before gates | 0 | superseded |
| 2026-02-20 | [TEST] Add cross-surface parity regression for blocked compaction counters | dev/add-cross-surface-parity-regression-for- | worktree missing before gates | 0 | superseded |
| 2026-02-20 | [TEST] Add cross-surface parity regression for blocked compaction counters | dev/add-cross-surface-parity-regression-for- | claude exit code 1 | 0 | superseded |
| 2026-02-20 | [DATA] Keep CLI `status --json` reconciliation counters aligned to watchdog snapshot semantics | fix/keep-cli-status---json-reconciliation-co | usage limit (no attempt recorded) | 0 | superseded |
| 2026-02-20 | [TEST] Add watchdog shell regression for telemetry snapshot determinism and no-op rewrites | fix/add-watchdog-shell-regression-for-teleme | usage limit (no attempt recorded) | 0 | superseded |
| 2026-02-20 | [TEST] Add cross-surface parity regression for watchdog snapshot consumers | fix/add-cross-surface-parity-regression-for- | usage limit (no attempt recorded) | 0 | superseded |
| 2026-02-20 | [TEST] Add watchdog shell regression for telemetry snapshot determinism and no-op rewrites | fix/add-watchdog-shell-regression-for-teleme | usage limit (no attempt recorded) | 0 | superseded |
| 2026-02-19 | [FEAT] Add self-correction metrics tracking | dev/add-self-correction-metrics-tracking--cr | playwright tests failed | 0 | superseded |
| 2026-02-19 | [INFRA] Add CI/CD workflow | dev/add-cicd-workflow--github-actions-for-ty | playwright tests failed | 0 | superseded |
| 2026-02-19 | [FEAT] Add webhook notification support | dev/add-webhook-notification-support--slack- | playwright tests failed | 0 | superseded |
| 2026-02-19 | [FEAT] we need to be able to see in admin for pipeline and monitoring who is active | dev/we-need-to-be-able-to-see-in-admin-for-p | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [TEST] Add integration test for full pipeline task lifecycle | dev/add-integration-test-for-full-pipeline-t | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [FEAT] Add `skynet logs` CLI command | dev/add-skynet-logs-cli-command--create-pack | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [TEST] Add Playwright tests for all dashboard component interactions | dev/add-playwright-tests-for-all-dashboard-c | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [INFRA] Add more tags and add tooltip to them | dev/add-more-tags-and-add-tooltip-to-them--a | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [FEAT] Add `skynet add-task` CLI command for backlog injection (old spec) | dev/title--description-optionally-appends--- | merge conflict | 0 | superseded |
| 2026-02-19 | [FEAT] Add Linux cron support to monitoring agents dashboard | dev/add-linux-cron-support-to-monitoring-age | merge conflict | 0 | superseded |
| 2026-02-19 | [FEAT] Add automatic stale branch cleanup for abandoned failed tasks | dev/add-automatic-stale-branch-cleanup-for-a | merge conflict | 0 | superseded |
| 2026-02-19 | [FIX] Fix watchdog hardcoded worker IDs breaking scaling beyond 2 workers | dev/fix-watchdog-hardcoded-worker-ids-breaki | merge conflict | 0 | superseded |
| 2026-02-19 | [FEAT] Add multi-project PID isolation validation | dev/add-multi-project-pid-isolation-validati | merge conflict | 0 | superseded |
| 2026-02-19 | [INFRA] Delete stale dev branches and prune worktrees | dev/delete-stale-dev-branches-and-prune-work | merge conflict | 0 | superseded |
| 2026-02-19 | [INFRA] Extend watchdog stale branch cleanup to handle fixed and superseded tasks | dev/extend-watchdog-stale-branch-cleanup-to- | merge conflict | 0 | superseded |
| 2026-02-19 | [FEAT] Add pipeline event log for audit trail and activity feed | dev/add-pipeline-event-log-for-audit-trail-a | merge conflict | 0 | superseded |
| 2026-02-19 | [TEST] Add events handler unit tests and ActivityFeed component tests | dev/add-events-handler-unit-tests-and-activi | merge conflict | 0 | superseded |
| 2026-02-19 | [FEAT] Add pipeline event log for audit trail and activity feed | dev/add-pipeline-event-log-for-audit-trail-a | merge conflict | 0 | superseded |
| 2026-02-19 | [FIX] Auto-supersede stale failed-task entries whose tasks were completed via fresh implementations | dev/auto-supersede-stale-failed-task-entries | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [TEST] Add events handler unit tests and ActivityFeed component tests | dev/add-events-handler-unit-tests-and-activi | merge conflict | 0 | superseded |
| 2026-02-19 | [TEST] Add mission-raw and pipeline-stream handler unit tests | -- | Stale lock after 45m | 0 | superseded |
| 2026-02-19 | [TEST] Add mission-raw and pipeline-stream handler unit tests | -- | Stale lock after 45m | 0 | superseded |
| 2026-02-19 | [TEST] Add mission-raw and pipeline-stream handler unit tests | -- | Stale lock after 45m | 0 | superseded |
| 2026-02-19 | [FEAT] Add JSON output mode to `skynet status` for programmatic access | dev/add-json-output-mode-to-skynet-status-fo | merge conflict | 0 | superseded |
| 2026-02-19 | [FEAT] Wire emit_event() into bash scripts (1st attempt | dev/wire-emitevent-calls-into-dev-workersh-t | claude exit code 143 | 0 | superseded |
| 2026-02-19 | [FEAT] Wire emit_event() into bash scripts (2nd attempt) | dev/wire-emitevent-calls-into-dev-workersh-t | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [DOCS] Update README CLI reference with upgrade, run, watch | dev/update-readme-cli-reference-with-upgrade | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [FEAT] Add `skynet metrics` CLI command | dev/counts-and-percentages-read-devfailed-ta | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [TEST] Add CLI unit tests for watch, run, upgrade, cleanup, metrics | dev/add-cli-unit-tests-for-watch-run-upgrade | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [FEAT] Add `/admin/events` page with EventsDashboard | dev/add-adminevents-page-with-event-filterin | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [INFRA] Add pipeline performance summary to project-driver | dev/add-pipeline-performance-summary-to-proj | claude exit code 1 | 0 | superseded |
| 2026-02-19 | [FIX] Clean up stale failed-tasks.md entries | dev/clean-up-stale-failed-tasksmd-entries-an | claude exit code 1 | 0 | superseded |
