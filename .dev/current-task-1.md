# Current Task
## [INFRA] Add project-driver backlog deduplication check — in `scripts/project-driver.sh`, after the LLM generates new tasks (the `claude` command output) but before appending them to backlog.md, check each new task line against existing pending `[ ]` and claimed `[>]` entries in the current backlog. Normalize comparison: strip tags (`[FEAT]`, `[FIX]`, etc.), lowercase, remove extra whitespace, take first 60 characters. Skip any new task whose normalized prefix matches an existing entry. Log "Skipped duplicate: <title>" for each skipped task. This prevents the project-driver from regenerating tasks that are already in the backlog or in progress, which wastes worker cycles. Criterion #3 (clean state, no wasted effort)
**Status:** completed
**Started:** 2026-02-20 00:36
**Completed:** 2026-02-20
**Branch:** dev/add-project-driver-backlog-deduplication
**Worker:** 1

### Changes
-- See git log for details
