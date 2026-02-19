# Current Task
## [FEAT] Add interactive mission template generator to `skynet init` — in `packages/cli/src/commands/init.ts`, after creating `.dev/mission.md` with default content, add an interactive prompt: "Would you like to define your project's mission now? (Y/n)". If yes, ask: (1) "What does your project do?" (one sentence), (2) "What are your top 3 goals?" (free text), (3) "What does 'done' look like?" (free text). Generate a populated mission.md with answers formatted into Purpose, Core Mission, and Success Criteria sections matching the existing mission.md structure. If no or `--non-interactive` flag, leave the default template. Criterion #1 (reduce friction between init and autonomous work)
**Status:** completed
**Started:** 2026-02-19 18:06
**Completed:** 2026-02-19
**Branch:** dev/add-interactive-mission-template-generat
**Worker:** 1

### Changes
-- See git log for details
