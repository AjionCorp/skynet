# Current Task
## [DOCS] Update README.md and packages/cli/README.md CLI reference tables with missing commands — the main `README.md` CLI Reference table (lines 36-56) lists 19 commands but is missing `export` ("Export pipeline state as a JSON snapshot"), `import` ("Restore pipeline state from an exported snapshot"), and `completions` ("Generate bash or zsh shell completions"). Add rows for all 3 after the `config` row. Also fix `SKYNET_MAX_WORKERS` default from `2` to `4` in the Configuration table (line 91) — this was fixed in `templates/skynet.config.sh` but the README was never updated. In `packages/cli/README.md`, add `import` ("Restore pipeline state from snapshot") and `completions` ("Generate shell completions for bash/zsh") to the Commands table after the `config` row. Update the total command count in any prose that mentions a specific number. Criterion #1 (accurate documentation)
**Status:** completed
**Started:** 2026-02-20 01:10
**Completed:** 2026-02-20
**Branch:** dev/update-readmemd-and-packagesclireadmemd-
**Worker:** 3

### Changes
-- See git log for details
