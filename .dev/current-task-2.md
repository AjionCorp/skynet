# Current Task
## [TEST] Add watchdog regression for fixing-root supersede behavior — in `scripts/tests/watchdog.sh`, add fixtures where the same normalized root appears as `fixing-*` plus `blocked|pending` rows and assert only the `fixing-*` row remains active, superseded rows preserve table validity/order, and second identical run is a no-op. Mission: Criterion #2 quality gates and Criterion #3 deterministic reconciliation.
**Status:** completed
**Started:** 2026-02-20 18:46
**Completed:** 2026-02-20
**Branch:** dev/add-watchdog-regression-for-fixing-root-
**Worker:** 2

### Changes
-- See git log for details
