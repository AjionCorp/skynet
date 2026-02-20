# Current Task
## [FIX] Remove duplicate `_cleanup_stale_branches` function in watchdog.sh — `scripts/watchdog.sh` defines `_cleanup_stale_branches()` twice: first at line ~435 (handles fixed|superseded|blocked statuses, deletes local+remote branches for all resolved failed tasks) and again at line ~503 (only handles blocked entries with 24h+ age check against blockers.md). The first definition runs at line ~487 and already comprehensively handles ALL resolved statuses including blocked. The second definition at ~503 silently redefines the function, then runs at ~570 doing redundant work (blocked branches were already deleted by the first call). Fix: delete the second function definition — remove the comment block starting with `# --- Stale branch cleanup for permanently failed tasks ---` (line ~500) through the closing brace (line ~567), and delete its invocation `_cleanup_stale_branches` at line ~570. Also remove the `cd "$PROJECT_DIR"` line just before it (line ~569) since it's only needed by the second call. The first, comprehensive version already covers all cases. This is a real bug from two separate tasks being merged independently. Run `pnpm typecheck` to verify no breakage. Criterion #3 (clean code, no redundant logic)
**Status:** completed
**Started:** 2026-02-20 01:10
**Completed:** 2026-02-20
**Branch:** dev/remove-duplicate-cleanupstalebranches-fu
**Worker:** 1

### Changes
-- See git log for details
