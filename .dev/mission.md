# Self-Aware Autonomous Pipeline
## State: active

## Purpose
Transform Skynet into a fully self-aware, self-improving autonomous development pipeline where every worker understands the system it operates within, every task drives measurable progress toward mission completion, and the pipeline can quantify performance, adapt priorities, and declare missions complete — all without human intervention.

## Goals
- [x] Implement mission lifecycle states (ACTIVE, ON_TRACK, AT_RISK, BLOCKED, DONE, ABANDONED) with automatic state transitions based on measurable criteria
- [x] Build a mission performance scoring system that tracks task completion rate, fix rate, velocity trend, and mission-alignment score per worker
- [x] Add worker context injection so each worker receives awareness of: active mission goals, other workers' current tasks, recent completions, known failure patterns, and pipeline health
- [x] Create a mission completion engine that automatically transitions missions to DONE when all success criteria are met, halting task generation and reassigning workers
- [x] Implement cross-worker coordination signals so workers avoid overlapping file edits, duplicate implementations, and merge conflicts through a shared intent registry
- [x] Build a self-improvement task generator that analyzes pipeline failure patterns, admin tool gaps, and worker inefficiencies to propose infrastructure improvements
- [x] Add a mission progress dashboard with real-time completion percentage, per-goal burndown, worker contribution breakdown, and projected completion timeline
- [x] Create an adaptive project driver that weights task generation toward lagging goals, deprioritizes areas with high failure rates, and adjusts batch size based on worker throughput
- [x] Implement structured task outcome tracking with success/failure reason taxonomy, duration, files touched, and merge conflict indicators stored in the metrics DB
- [ ] Build worker performance profiles that track per-worker success rate, average task duration, task-type strengths, and use this data to optimize task assignment

## Success Criteria
- [x] Every mission has a quantifiable completion percentage derived from checked success criteria AND task outcome data
- [x] Workers receive and utilize context about other active workers' tasks before claiming new work, reducing merge conflicts to near-zero
- [x] The project driver automatically stops generating tasks and transitions the mission to DONE when all goals and success criteria are satisfied
- [x] Pipeline health score incorporates mission-alignment metrics (not just operational health) — tasks that don't advance the mission are flagged
- [x] A self-improvement feedback loop exists: pipeline failures automatically generate infrastructure improvement tasks in the backlog
- [ ] Admin dashboard displays per-mission performance metrics including velocity, worker efficiency, goal progress, and estimated time to completion
- [x] Worker reassignment happens automatically when a mission reaches DONE state — idle workers pick up the next highest-priority active mission
- [x] The system can explain its own state: any API consumer can query why the pipeline is in its current state, what's blocking progress, and what would accelerate completion

## Current Focus
Phase 5: Mission completion — 1 unchecked goal and 1 unchecked success criterion remain. Goal 8 (adaptive driver) completed 2026-03-05 with all three wirings merged.

Remaining:
(a) Goal 10 — worker performance profiles: `tagBreakdown` type + handler population landed. Still need: `db_get_worker_tag_breakdown()` DB query (pending), tag affinity visualization in component (claimed). Once both land, Goal 10 is done.
(b) Success Criterion 6 — Per-goal ETA exists in MissionGoalProgress. Missing: `overallMissionEta` computation in burndown handler (claimed) and display in component header (claimed). Once both land, SC6 is done.
(c) When Goal 10 + SC6 are met, all 10 goals and 8 success criteria are satisfied → mission transitions to DONE automatically via mission-state.sh.
