# Current Task
## [FIX] Truncate completed.md to last 30 entries in project-driver.sh prompt context — in `scripts/project-driver.sh` line 59, `completed_content=$(cat "$COMPLETED")` loads the ENTIRE 132KB (35K tokens) completed.md into the LLM prompt. With 164+ entries and growing, this wastes API credits and context window on every project-driver invocation. The LLM only needs recent completions for deduplication context (which is now handled separately by the dedup check). Fix: change line 59 from `completed_content=$(cat "$COMPLETED")` to `completed_content=$(head -2 "$COMPLETED"; tail -30 "$COMPLETED")` — keeps the markdown table header (2 lines) plus only the last 30 entries. This cuts prompt size by ~80% (~28K tokens saved per run). Also change the prompt text at line 129 from `### Completed Tasks (.dev/completed.md)` to `### Recent Completed Tasks (last 30 of $(wc -l < "$COMPLETED") entries)`. Run `pnpm typecheck`. Criterion #3 (efficient resource usage — saves ~$0.50+ per project-driver run)
**Status:** completed
**Started:** 2026-02-20 01:40
**Completed:** 2026-02-20
**Branch:** dev/truncate-completedmd-to-last-30-entries-
**Worker:** 4

### Changes
-- See git log for details
