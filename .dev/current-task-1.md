# Current Task
## [FEAT] Add shell completions for bash and zsh — create `packages/cli/src/commands/completions.ts`. Register as `program.command('completions').description('Generate shell completions')` with `.argument('<shell>', 'Shell type: bash or zsh')` in `packages/cli/src/index.ts`. For bash: output a `complete -W "<all-commands>" skynet` script plus per-command flag completions using `_skynet()` function with `COMPREPLY`. For zsh: output a `#compdef skynet` script using `_arguments` with all 22 commands and their flags. Include all registered commands: init, setup-agents, start, stop, pause, resume, status, doctor, logs, version, add-task, run, dashboard, reset-task, cleanup, watch, upgrade, metrics, export, import, config, completions. Print installation hint to stderr: "# Add to ~/.bashrc: eval \"$(skynet completions bash)\"". Criterion #1 (developer experience — tab completion for 22 commands)
**Status:** completed
**Started:** 2026-02-20 00:56
**Completed:** 2026-02-20
**Branch:** dev/add-shell-completions-for-bash-and-zsh--
**Worker:** 1

### Changes
-- See git log for details
