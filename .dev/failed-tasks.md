# Failed Tasks

| Date | Task | Branch | Error | Reason | Attempts | Status |
|------|------|--------|-------|--------|----------|--------|
| 2026-03-05 | [INFRA] Add mission queue directory convention and `_next_queued_mission()` helper | dev/add-mission-queue-directory-convention-a | merge conflict | merge_conflict | 0 | failed |
| 2026-03-04 | [INFRA] Wire adaptive goal weighting into project-driver.sh | dev/wire-adaptive-goal-weighting-into-projec | merge conflict after fix attempt 1 | merge_conflict | 1 | superseded |
| 2026-03-04 | [INFRA] Align `scripts/mission-state.sh` state names with mission spec | dev/align-scriptsmission-statesh-state-names | merge conflict after fix attempt 3 | merge_conflict | 3 | superseded |
| 2026-03-04 | [INFRA] Add intent-aware negative constraints to `scripts/project-driver.sh` task generation | dev/add-intent-aware-negative-constraints-to | merge conflict after fix attempt 3 | merge_conflict | 3 | superseded |
| 2026-03-04 | [INFRA] Add adaptive task weighting toward lagging mission goals in project-driver prompt | dev/add-adaptive-task-weighting-toward-laggi | merge conflict after fix attempt 3 | merge_conflict | 3 | superseded |
| 2026-03-04 | [INFRA] Add mission state badge to admin Pipeline dashboard | merged to main | merge conflict |  | 1 | fixed |
| 2026-03-04 | [DATA] Create `/api/admin/mission/state` endpoint for lifecycle state visibility | merged to main | merge conflict |  | 1 | fixed |
| 2026-03-04 | [INFRA] Add `outcome_reason` and `files_touched` columns to SQLite tasks table | merged to main | merge conflict |  | 1 | fixed |
| 2026-03-03 | [TEST] Add end-to-end LLM config smoke test for shell pipeline | merged to main | merge conflict |  | 1 | fixed |
| 2026-03-03 | [FIX] Prune completed.md to last 50 entries | merged to main | merge conflict after fix attempt 1 |  | 2 | fixed |
| 2026-02-25 | [TEST] [TEST] Add unit tests for `_config.sh` shared infrastructure helpers | merged to main | typecheck failed post-merge |  | 1 | fixed |
| 2026-02-25 | [DATA] [DATA] Refresh `.dev/blockers.md` active status from canonical state and add mission-achieved celebration block | merged to main | merge conflict |  | 1 | fixed |
| 2026-02-25 | [INFRA] [INFRA] Auto-supersede stale `status=failed` rows when canonical root is already merged | merged to main | merge conflict |  | 1 | fixed |
| 2026-02-25 | [TEST] [TEST] Add init/setup-agents end-to-end regression for zero-to-autonomy bootstrap | merged to main | typecheck failed |  | 1 | fixed |
| 2026-02-24 | [TEST] Add unit tests for _merge.sh shared merge-to-main logic | merged to main | claude exit code 1 |  | 1 | fixed |
| 2026-02-24 | [TEST] Add unit tests for _config.sh shared infrastructure helpers | merged to main | all agents hit usage limits (no attempt recorded) |  | 3 | fixed |
| 2026-02-24 | [TEST] Add integration test for watchdog crash recovery end-to-end | merged to main | typecheck failed after fix attempt 1 (fix attempt 2 failed) |  | 3 | fixed |
| 2026-02-24 | [INFRA] Add pipeline idle detection and completion signaling to watchdog | merged to main | all agents hit usage limits (no attempt recorded) |  | 2 | fixed |
| 2026-02-24 | [TEST] Add handler unit tests for mission-raw and pipeline-stream | merged to main | typecheck failed |  | 1 | fixed |
| 2026-02-24 | [INFRA] Add prompt size guardrail before LLM agent invocation | merged to main | merge conflict |  | 1 | fixed |
| 2026-02-24 | [INFRA] Sync backlog.md claimed markers with DB state during watchdog reconciliation | merged to main | worktree missing before gates |  | 1 | fixed |
| 2026-02-24 | [TEST] Add unit tests for _locks.sh atomic locking and merge mutex | merged to main | typecheck failed |  | 1 | fixed |
| 2026-02-24 | [FIX] Separate rate_limits write path from read-only DB access | merged to main | worktree missing before gates |  | 1 | fixed |
| 2026-02-24 | [INFRA] Complete echo agent dry-run lifecycle in scripts/agents/echo.sh | merged to main | typecheck failed |  | 1 | fixed |
| 2026-02-24 | [DATA] Refresh blockers.md Active section to match current resolved state | merged to main | merge conflict |  | 1 | fixed |
| 2026-02-24 | [FEAT] Add pipeline health trend sparkline to Pipeline dashboard | merged to main | merge conflict after fix attempt 1 |  | 2 | fixed |
| 2026-02-24 | [FEAT] Add keyboard shortcuts to dashboard | merged to main | merge conflict after fix attempt 2 |  | 3 | fixed |
| 2026-02-24 | [FEAT] Add task completion velocity chart to Pipeline dashboard | merged to main | merge conflict after fix attempt 2 |  | 3 | fixed |
| 2026-03-05 | [INFRA] Add `_get_mission_llm_config` shell helper and thread model into worker agent invocation | merged to main | Phantom completion: implementation commit lost during merge, function not present on main |  | 1 | fixed |
| 2026-03-03 | [FIX] Commit orphaned _merge.sh stale-index recovery and supersede 2 blocked failed rows | dev/commit-orphaned-mergesh-stale-index-reco | merge conflict after fix attempt 2 |  | 2 | superseded |
| 2026-03-03 | [INFRA] Add stale unmerged .dev/ index recovery to _merge.sh merge pipeline | dev/add-stale-unmerged-dev-index-recovery-to | merge conflict after fix attempt 3 |  | 3 | superseded |
| 2026-03-03 | [DATA] Update mission.md to declare LLM Provider Selection mission complete | dev/update-missionmd-to-declare-llm-provider | merge conflict after fix attempt 3 |  | 3 | superseded |
| 2026-03-03 | [TEST] Add shell regression for `_get_mission_llm_config` helper | dev/add-shell-regression-for-getmissionllmco | typecheck failed |  | 0 | superseded |
| 2026-03-03 | [TEST] Add handler tests for mission LLM config persistence and retrieval | dev/add-handler-tests-for-mission-llm-config | typecheck failed |  | 0 | superseded |
| 2026-03-03 | [INFRA] Add `_get_mission_llm_config` shell helper to read per-mission LLM settings | dev/add-getmissionllmconfig-shell-helper-to- | typecheck failed |  | 0 | superseded |
| 2026-03-03 | [INFRA] Thread mission LLM config into dev-worker and task-fixer agent invocation | dev/thread-mission-llm-config-into-dev-worke | typecheck failed |  | 0 | superseded |
| 2026-03-03 | [FEAT] Display assigned LLM model badge on mission cards and detail view | dev/display-assigned-llm-model-badge-on-miss | merge conflict |  | 0 | superseded |
| 2026-03-03 | [INFRA] Add `--model` flag support to Claude agent plugin | dev/add---model-flag-support-to-claude-agent | typecheck failed |  | 0 | superseded |
| 2026-03-03 | [FEAT] Make sure to use shadnc components for the admin | dev/make-sure-to-use-shadnc-components-for-t | typecheck failed |  | 0 | superseded |
| 2026-03-03 | [FEAT] Add LLM model selector dropdown to MissionDashboard component | dev/add-llm-model-selector-dropdown-to-missi | typecheck failed |  | 0 | superseded |
| 2026-03-03 | [DATA] Accept and persist LLM config in mission create and detail PUT handlers | dev/accept-and-persist-llm-config-in-mission | merge conflict |  | 0 | superseded |
| 2026-03-03 | [TEST] test task | dev/test-task | merge conflict |  | 0 | superseded |
| 2026-03-03 | [DATA] Include per-mission LLM config in missions list and detail GET responses | dev/include-per-mission-llm-config-in-missio | typecheck failed |  | 0 | superseded |
| 2026-03-03 | [INFRA] Add `LlmConfig` type and extend `MissionConfig`/`MissionSummary` in dashboard types | dev/add-llmconfig-type-and-extend-missioncon | merge conflict |  | 0 | superseded |
| 2026-02-26 | [INFRA] Auto-supersede stale `status=failed` rows when canonical root is already merged | dev/auto-supersede-stale-statusfailed-rows-w | claude exit code 125 |  | 0 | superseded |
| 2026-02-25 | [TEST] Add init/setup-agents end-to-end regression for zero-to-autonomy bootstrap | dev/add-initsetup-agents-end-to-end-regressi | typecheck failed |  | 0 | superseded |
| 2026-02-25 | [FIX] Separate `rate_limits` write path from read-only DB access | dev/separate-ratelimits-write-path-from-read | merge conflict |  | 0 | superseded |
| 2026-02-25 | [FIX] [FIX] Separate `rate_limits` write path from read-only DB access | dev/separate-ratelimits-write-path-from-read | typecheck failed |  | 0 | superseded |
| 2026-02-25 | [INFRA] [INFRA] Complete echo agent dry-run lifecycle in `scripts/agents/echo.sh` | dev/complete-echo-agent-dry-run-lifecycle-in | worktree missing before gates |  | 0 | superseded |
| 2026-03-05 | [INFRA] Add _get_mission_llm_config shell helper and thread model into worker agent invocation |  |  |  | 0 | superseded |
