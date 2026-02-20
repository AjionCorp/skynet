# Current Task
## [INFRA] Harden project-driver generation filter against retry-root duplication — in `scripts/project-driver.sh`, reject new unchecked tasks whose normalized title matches any active failed-task root (including `fixing-*`), log each skip, and keep unchecked backlog count <= 15. Mission: Criterion #3 convergent planning and Criterion #2 retry-loop stability.
**Status:** completed
**Started:** 2026-02-20 15:56
**Completed:** 2026-02-20
**Branch:** dev/harden-project-driver-generation-filter-
**Worker:** 4

### Changes
-- See git log for details
