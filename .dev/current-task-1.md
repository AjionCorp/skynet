# Current Task
## [INFRA] Close stale-active failed-root drift in one deterministic watchdog sweep — in `scripts/watchdog.sh`, run a canonical active-root convergence pass that supersedes only `status=blocked|pending` rows whose normalized root is already present in `.dev/completed.md`, preserves `fixing-*` rows byte-for-byte, and emits before/after counters plus one stable root-hash summary. Mission: Criterion #2 self-correction throughput and Criterion #3 convergent state.
**Status:** completed
**Started:** 2026-02-20 18:11
**Completed:** 2026-02-20
**Branch:** dev/close-stale-active-failed-root-drift-in-
**Worker:** 1

### Changes
-- See git log for details
