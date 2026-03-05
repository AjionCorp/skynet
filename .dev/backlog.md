# Backlog

<!-- Priority: top = highest. Format: - [ ] [TAG] Task title — description -->
<!-- Markers: [ ] = pending, [>] = claimed by worker, [x] = done -->

- [ ] [FEAT] B
- [ ] [FEAT] A
- [ ] [TEST] Add regression for mission DONE transition when all checkboxes are checked — in `tests/unit/`, create a test that sources `scripts/mission-state.sh`, provides a fixture mission.md with all goals and criteria checked, and asserts `transition_mission_state()` transitions from ACTIVE to DONE. Mission: Goal 4 quality gates.
- [ ] [TEST] Add unit test for worker intent overlap detection — in `tests/unit/`, create a test that sources `scripts/_locks.sh` (or the intent helper), writes overlapping intent entries to a fixture `.dev/worker-intents.md`, and asserts the overlap detection function correctly identifies file-level and directory-level conflicts. Mission: Goal 5 quality gates.
- [>] [INFRA] Archive resolved blockers older than 14 days from `.dev/blockers.md` — move the 40+ resolved entries from Feb 19-25 to a new `.dev/blockers-archive.md` file, keeping only the Active section, MISSION ACHIEVED summaries, and Resolved (Recent) section in the main file. This reduces prompt bloat when blockers.md is loaded into context. Mission: pipeline efficiency.
- [ ] [TEST] Add unit test for `_adaptive_order_clause()` priority weighting — in `tests/unit/`, create a test that sources `scripts/_adaptive.sh`, calls `_adaptive_order_clause()` with various goal-progress fixtures, and asserts the returned SQL ORDER BY clause correctly prioritizes lagging goals. Mission: Goal 8 quality gates.
