# Current Task
## [FIX] Add merge conflict detection and fresh-branch retry to task-fixer — in `scripts/task-fixer.sh`, before attempting to fix a failed task on its existing branch, check if the branch can merge cleanly into main: run `git merge-tree $(git merge-base main "$BRANCH") main "$BRANCH"` and grep for conflict markers. If conflicts are detected, log "Branch $BRANCH has merge conflicts — creating fresh branch", delete the old branch (`git branch -D "$BRANCH"`), and create a new branch from main instead of checking out the stale one. This prevents the fixer from wasting cycles on unmergeable branches and dramatically improves self-correction success rate for tasks that failed after main has diverged
**Status:** completed
**Started:** 2026-02-19 17:15
**Completed:** 2026-02-19
**Branch:** dev/add-merge-conflict-detection-and-fresh-b
**Worker:** 4

### Changes
-- See git log for details
