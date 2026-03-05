# Backlog

<!-- Priority: top = highest. Format: - [ ] [TAG] Task title — description -->
<!-- Markers: [ ] = pending, [>] = claimed by worker, [x] = done -->

- [ ] [FEAT] B
- [ ] [FEAT] A
- [ ] [TEST] Add unit test for worker intent overlap detection — in `tests/unit/`, create a test that sources `scripts/_locks.sh` (or the intent helper), writes overlapping intent entries to a fixture `.dev/worker-intents.md`, and asserts the overlap detection function correctly identifies file-level and directory-level conflicts. Mission: Goal 5 quality gates.
- [ ] [TEST] Add unit test for `_adaptive_order_clause()` priority weighting — in `tests/unit/`, create a test that sources `scripts/_adaptive.sh`, calls `_adaptive_order_clause()` with various goal-progress fixtures, and asserts the returned SQL ORDER BY clause correctly prioritizes lagging goals. Mission: Goal 8 quality gates.
