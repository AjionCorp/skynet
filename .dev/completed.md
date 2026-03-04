# Completed Tasks

| Date | Task | Branch | Duration | Notes |
|------|------|--------|----------|-------|
| 2026-03-04 | [INFRA] Add mission-alignment scoring to pipeline health calculation | merged to main | 6m | success |
| 2026-03-04 | [TEST] Add handler test for failure-analysis endpoint | merged to main | 2m | success |
| 2026-03-04 | [TEST] Add shell regression for `db_get_worker_performance` query | merged to main | 2m | success |
| 2026-03-04 | [DATA] Add `/api/admin/pipeline/failure-analysis` endpoint | merged to main | 5m | success |
| 2026-03-04 | [INFRA] Wire failure analyzer into watchdog cycle and auto-generate INFRA tasks on threshold breach | merged to main | 6m | success |
| 2026-03-04 | [INFRA] Add worker reassignment protocol on mission DONE in `scripts/dev-worker.sh` and `scripts/task-fixer.sh` | merged to main | 1m | success |
| 2026-03-04 | [DATA] Surface per-worker performance stats in pipeline-status API response | merged to main | 4m | success |
| 2026-03-04 | [INFRA] Build failure pattern analyzer in `scripts/failure-analyzer.sh` | merged to main | 3m | success |
| 2026-03-04 | [INFRA] Add `db_get_worker_performance` query to `scripts/_db.sh` | merged to main | 1m | success |
| 2026-03-04 | [TEST] Add handler tests for `/api/admin/mission/state` endpoint | merged to main | 6m | success |
| 2026-03-04 | [DATA] Surface mission lifecycle state in pipeline-status and CLI status responses | merged to main | 5m | success |
| 2026-03-04 | [INFRA] Add worker context injection with other workers' active tasks into Claude Code prompt | merged to main | 3m | success |
| 2026-03-04 | [INFRA] Record failure reason codes in `dev-worker.sh` task completion | merged to main | 4m | success |
| 2026-03-04 | [INFRA] Wire `project-driver.sh` to respect mission lifecycle state | merged to main | 4m | success |
| 2026-03-04 | [INFRA] Record `files_touched` on task completion in `dev-worker.sh` | merged to main | 1m | success |
| 2026-03-04 | [INFRA] Add `## State: ACTIVE` line to mission file format and `_get_mission_state` helper | merged to main | 5m | success |
| 2026-03-04 | [TEST] Add shell regression for `mission-state.sh` state transitions | merged to main | 4m | success |
| 2026-03-04 | [INFRA] Wire `watchdog.sh` to evaluate mission state transitions each cycle | merged to main | 3m | success |
| 2026-03-04 | [INFRA] Create `scripts/mission-state.sh` state machine function library | merged to main | 3m | success |
| 2026-03-04 | [TEST] Add shell regression for mission LLM override/default execution in canonical harness | merged to main | 4m | success |
| 2026-03-04 | [INFRA] Prevent stale `scripts/tests/*` references in generated shell test tasks | merged to main | 2m | success |
| 2026-03-04 | [DATA] Default `activeMission.llmConfig` when mission override is missing or partial | merged to main | 3m | success |
| 2026-03-04 | [TEST] Add handler regressions for Claude tier validation in mission writes | merged to main | 2m | success |
| 2026-03-04 | [DATA] Surface active mission LLM source (`explicit` vs `default`) in status payloads | merged to main | 4m | success |
| 2026-03-04 | [TEST] Add cross-surface parity tests for active mission LLM source metadata | merged to main | 3m | success |
| 2026-03-04 | [FIX] Enforce canonical Claude tier model validation in mission LLM writes | merged to main | 3m | success |
| 2026-03-04 | [TEST] Add MissionDashboard regression for provider/model coupling safety | merged to main | 1m | success |
| 2026-03-04 | [TEST] Restore shell test infrastructure coverage for mission LLM flow | merged to main | 1m | success |
| 2026-03-04 | [TEST] Add cross-surface parity tests for mission-status LLM defaults | merged to main | 5m | success |
| 2026-03-04 | [DATA] Default `activeMission.llmConfig` in mission status payloads when mission has no explicit override | merged to main | 4m | success |
| 2026-03-04 | [INFRA] Auto-demote stale claimed backlog rows whose normalized roots are already completed | merged to main | 4m | success |
| 2026-03-04 | [FIX] Re-land stale unmerged `.dev/` index recovery in merge pipeline | merged to main | 3m | success |
| 2026-03-04 | [TEST] Add pipeline-status projection unit coverage for malformed/legacy mission LLM payloads | merged to main | 4m | success |
| 2026-03-04 | [TEST] Add worker mission-LLM shell parity coverage for explicit and defaulted models | merged to main | 2m | success |
| 2026-03-04 | [TEST] Add mission-status/CLI/pipeline-status triple-parity fixture for active mission LLM defaults | merged to main | 5m | success |
| 2026-03-04 | [TEST] Add admin mission API regression for defaulted vs explicit LLM model persistence | merged to main | 2m | success |
| 2026-03-04 | [INFRA] Centralize mission LLM default projection into one shared helper | merged to main | 2m | success |
| 2026-03-04 | [DATA] Keep pipeline-status active mission LLM payload aligned with mission-status projection semantics | merged to main | 5m | success |
| 2026-03-04 | [INFRA] Remove stale `scripts/tests/*` references from project-driver prompt templates | merged to main | 2m | success |
| 2026-03-04 | [TEST] Add pipeline-status route regression for defaulted vs explicit mission LLM model projection | merged to main | 2m | success |
| 2026-03-04 | [TEST] Add Codex agent `--model` passthrough regression for default-preserving behavior | merged to main | 2m | success |
| 2026-03-04 | [TEST] Add CLI and cross-surface parity regression for active mission LLM payload | merged to main | 4m | success |
| 2026-03-04 | [INFRA] Centralize mission LLM defaulting/projection into a shared helper consumed by mission-status and CLI status | merged to main | 4m | success |
| 2026-03-04 | [TEST] Add handler and route regression for mission-status LLM payload defaulting | merged to main | 4m | success |
| 2026-03-04 | [DATA] Keep CLI `status --json` active mission LLM projection aligned with dashboard mission-status semantics | merged to main | 3m | success |
| 2026-03-04 | [INFRA] Add Codex agent `--model` passthrough for mission-selected model | merged to main | 3m | success |
| 2026-03-04 | [TEST] Add shell regression for Codex agent model flag passthrough | merged to main | 1m | success |
| 2026-03-04 | [DATA] Surface assigned mission LLM in mission status endpoint payload | merged to main | 2m | success |
| 2026-03-04 | [TEST] Add end-to-end mission LLM routing smoke for worker invocation | merged to main | 2m | success |
| 2026-03-04 | [TEST] Add shell regression for provider-specific model env isolation | merged to main | 1m | success |
