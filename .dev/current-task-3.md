# Current Task
## [INFRA] Enforce canonical backlog marker ordering before each dispatch cycle — in `scripts/watchdog.sh` (or shared `_config.sh` helper), run a pre-cycle sanitizer that guarantees all `[>]` rows stay first, `[ ]` rows follow, and any misplaced top-level `[x]` rows are moved into checked history without rewriting claimed lines byte-for-byte. Mission: Criterion #3 deterministic planning state and Criterion #2 no-task-loss reliability.
**Status:** completed
**Started:** 2026-02-20 17:14
**Completed:** 2026-02-20
**Branch:** dev/enforce-canonical-backlog-marker-orderin
**Worker:** 3

### Changes
-- See git log for details
