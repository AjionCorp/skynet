# Current Task
## [FIX] Update README CLI reference to include pause, resume, and config commands — in `README.md`, the CLI Reference table lists 12 commands but is missing 3 that were added after the README was created: `pause` (pause the pipeline — workers exit gracefully, watchdog continues health checks), `resume` (resume paused pipeline — removes sentinel file, workers restart on next watchdog cycle), and `config` (view/edit skynet.config.sh — `config list`, `config get KEY`, `config set KEY VALUE` with validation). Add rows for all 3 to the CLI Reference table matching the existing description style. Also update the command count from "12 commands" to "15 commands" in any prose that references it. Criterion #1 (accurate developer documentation)
**Status:** completed
**Started:** 2026-02-19 20:53
**Completed:** 2026-02-19
**Branch:** dev/update-readme-cli-reference-to-include-p
**Worker:** 3

### Changes
-- See git log for details
