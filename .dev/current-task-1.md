# Current Task
## [FIX] Guard `skynet init` against re-run silently overwriting existing `skynet.config.sh` — in `packages/cli/src/commands/init.ts` line 179, `writeFileSync(join(devDir, "skynet.config.sh"), configContent)` unconditionally overwrites the config file. If a user accidentally re-runs `skynet init` in an already-initialized project, their customized config (port, notification tokens, agent settings) is silently destroyed. The `.md` state files are correctly guarded with `existsSync` checks, but the two shell config files are not. Fix: before writing `skynet.config.sh` (line 179) and `skynet.project.sh` (line 184), check `existsSync`. If the file exists AND `--force` is not set, print `"  Existing skynet.config.sh found — skipping (use --force to overwrite)"` and skip. Add `.option('--force', 'Overwrite existing config files')` to the init command options. Run `pnpm typecheck`. Criterion #1 (safe init — no accidental config destruction on re-run)
**Status:** completed
**Started:** 2026-02-20 03:22
**Completed:** 2026-02-20
**Branch:** dev/guard-skynet-init-against-re-run-silentl
**Worker:** 1

### Changes
-- See git log for details
