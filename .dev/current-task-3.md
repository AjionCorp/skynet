# Current Task
## [INFRA] Add pipeline velocity metrics to project-driver.sh prompt context — FRESH implementation (delete stale branch `dev/add-pipeline-performance-summary-to-proj` first). In `scripts/project-driver.sh`, before the Claude prompt (around line 100), compute: `today_completed=$(grep -c "$(date '+%Y-%m-%d')" "$COMPLETED" 2>/dev/null || echo 0)`, `total_completed=$(grep -c '^|' "$COMPLETED" 2>/dev/null || echo 0)`, `total_failed=$(grep -c '^|' "$FAILED" 2>/dev/null || echo 0)`, `fixed_count=$(grep -c 'fixed' "$FAILED" 2>/dev/null || echo 0)`, `fix_rate=$((fixed_count * 100 / (total_failed > 0 ? total_failed : 1)))`. Add a "## Pipeline Velocity" section to the prompt including these numbers. Log the summary to the project-driver log. This helps the LLM make smarter task generation decisions. Criterion #3 and #5
**Status:** completed
**Started:** 2026-02-20 00:19
**Completed:** 2026-02-20
**Branch:** dev/add-pipeline-velocity-metrics-to-project
**Worker:** 3

### Changes
-- See git log for details
