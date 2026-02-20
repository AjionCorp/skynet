# Current Task
## [FIX] Fix project-driver deduplication to include completed.md and `[x]` backlog entries — in `scripts/project-driver.sh`, the deduplication logic at lines 215-219 only snapshots pending `[ ]` and claimed `[>]` backlog entries via `grep '^\- \[[ >]\]'`. It NEVER reads `completed.md`. When the backlog empties, the LLM regenerates already-completed tasks because the dedup guard allows them through. This caused `completions` to be executed 15+ times and `watch` 8+ times. Fix: (1) At line 216, also include `[x]` entries: change `grep '^\- \[[ >]\]'` to `grep '^\- \[[ >x]\]'`. (2) After line 219, add: `if [ -f "$COMPLETED" ]; then awk -F'|' 'NR>2 {t=$3; gsub(/^ +| +$/,"",t); if(t!="") print "- [ ] " t}' "$COMPLETED" >> "$_dedup_snapshot"; while IFS= read -r _line; do _normalize_task_line "$_line"; done < <(tail -n +3 "$_dedup_snapshot") >> "$_dedup_normalized"; fi`. This ensures tasks already in completed.md are never regenerated. Run `pnpm typecheck`. Criterion #3 (no wasted cycles — this single bug wasted ~30% of all API credits)
**Status:** completed
**Started:** 2026-02-20 01:40
**Completed:** 2026-02-20
**Branch:** dev/-t-completed--dedupsnapshot-while-ifs-re
**Worker:** 1

### Changes
-- See git log for details
