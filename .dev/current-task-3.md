# Current Task
## [FIX] Fix `_agent.sh` relative plugin path resolution breaking custom agents — in `scripts/_agent.sh` line 65, `_resolve_plugin_path()` returns relative paths unchanged: `*) echo "$name" ;;`. The plugin is then sourced with `source "$_plugin_resolved"`, but `$PWD` at source time is not where the user placed their plugin. A user setting `SKYNET_AGENT_PLUGIN="./my-agent.sh"` gets "FATAL: Agent plugin not found" because the file check at line 101 runs from a different directory. Fix: in the `*)` case of `_resolve_plugin_path()`, resolve relative paths against `$PROJECT_DIR`: `*) if [ -f "$PROJECT_DIR/$name" ]; then echo "$PROJECT_DIR/$name"; elif [ -f "$name" ]; then echo "$name"; else echo "$name"; fi ;;`. This makes `SKYNET_AGENT_PLUGIN="./my-agent.sh"` resolve relative to the project root. Run `bash -n scripts/_agent.sh`. Criterion #6 (extensibility — custom agent plugins must actually work)
**Status:** completed
**Started:** 2026-02-20 02:21
**Completed:** 2026-02-20
**Branch:** dev/fix-agentsh-relative-plugin-path-resolut
**Worker:** 3

### Changes
-- See git log for details
