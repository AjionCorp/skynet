# Current Task
## [FIX] Fix mission criterion #2 evaluation formula in CLI status and pipeline-status handler — both `packages/cli/src/commands/status.ts` (line 393) and `packages/dashboard/src/handlers/pipeline-status.ts` (line 393) evaluate criterion #2 using `fixedCount / totalFailed` which gives ~14% because it divides `fixed` (5) by ALL failed entries (36). The correct formula — already used by the self-correction rate display on status.ts line 325 — is `(fixed + superseded) / (fixed + superseded + blocked)` which gives ~97%. Fix: in status.ts, replace the criterion #2 case (lines 390-397) to use the already-computed `scrSelfCorrected` and `scrResolved` variables. In pipeline-status.ts, do the same — use `selfCorrectedCount / (selfCorrectedCount + blockedCount)` instead of `fixedCount / totalFailed`. This is the single remaining display bug preventing all 6 mission criteria from showing as "met". Criterion #2 (accurate self-correction reporting)
**Status:** completed
**Started:** 2026-02-19 22:00
**Completed:** 2026-02-19
**Branch:** dev/fix-mission-criterion-2-evaluation-formu
**Worker:** 1

### Changes
-- See git log for details
