# Current Task
## [INFRA] Add automatic merge retry with rebase in dev-worker.sh — in `scripts/dev-worker.sh`, when `git merge "$branch_name" --no-edit` fails at line 550, instead of immediately marking the task as failed, attempt recovery: (a) `git merge --abort`, (b) `git pull origin main` to get latest, (c) `git checkout "$branch_name"`, (d) `git rebase main` — if rebase succeeds, checkout main and retry merge. Add a retry counter (max 1 rebase attempt). If rebase itself has conflicts, `git rebase --abort` and proceed to fail the task as before. Log "Merge conflict — attempting rebase recovery..." for visibility. Currently ~15% of task failures are merge conflicts from concurrent workers, all of which go to the task-fixer for a full retry cycle. Inline rebase recovery would resolve most of these in seconds instead of minutes, directly improving throughput and reducing API credit usage. Criterion #2 (self-correction) and #3 (reliability)
**Status:** completed
**Started:** 2026-02-20 00:43
**Completed:** 2026-02-20
**Branch:** dev/add-automatic-merge-retry-with-rebase-in
**Worker:** 3

### Changes
-- See git log for details
