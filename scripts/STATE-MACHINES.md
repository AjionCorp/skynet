# Skynet Pipeline — State Machines & Guard Times

Reference for task lifecycle, worker/fixer state machines, lock hierarchy,
and timing thresholds. All `file:line` references are canonical.

---

## 1. Task State Machine

```
                        ┌─────────┐
            db_add_task │ pending │ ← initial state
           (_db.sh:274) └────┬────┘
                             │
               db_claim_next_task (_db.sh:180)
                             │
                        ┌────▼────┐
                        │ claimed │
                        └──┬──┬──┬┘
                           │  │  │
          ┌────────────────┘  │  └────────────────┐
          │                   │                   │
   db_complete_task    db_fail_task       watchdog orphan
    (_db.sh:246)       (_db.sh:261)      reconciliation
          │                   │          (watchdog.sh:302)
          ▼                   │           db_unclaim_task
   ┌───────────┐              │          (_db.sh:229)
   │ completed │              │                │
   └───────────┘              ▼                ▼
                        ┌──────────┐     ┌─────────┐
                        │  failed  │◄────│ pending │
                        └──┬──┬──┬─┘     │ (retry) │
                           │  │  │       └─────────┘
             ┌─────────────┘  │  └─────────────┐
             │                │                │
      db_claim_failure  db_block_task   db_supersede_task
       (_db.sh:330)     (_db.sh:379)     (_db.sh:384)
             │                │         db_auto_supersede
             ▼                ▼          (_db.sh:398)
      ┌────────────┐   ┌─────────┐          │
      │ fixing-{N} │   │ blocked │          ▼
      └──┬──┬──────┘   └─────────┘   ┌────────────┐
         │  │                         │ superseded │
         │  │                         └────────────┘
         │  db_fix_task
         │  (_db.sh:365)
         │       │
         │       ▼
         │  ┌─────────┐
         │  │  fixed   │
         │  └─────────┘
         │
         │  db_unclaim_failure (_db.sh:343)
         │  db_update_failure  (_db.sh:352)
         │  watchdog stale fixing (watchdog.sh:326)
         │
         ▼
   ┌──────────┐
   │  failed  │  (retry cycle)
   └──────────┘
```

### Terminal states

| State | Meaning | Trigger |
|-------|---------|---------|
| `completed` | Merged to main by dev-worker | `db_complete_task` |
| `fixed` | Merged to main by task-fixer | `db_fix_task` |
| `blocked` | Exceeded max fix attempts | `db_block_task` |
| `superseded` | Duplicate/moot — goal achieved via another path | `db_supersede_task` / `db_auto_supersede_completed` / `_auto_supersede_moot_blocked` |
| `done` | Task completed externally (manual mark-done, not via pipeline merge) | manual / API |

---

## 2. Dev-Worker State Machine

File: `scripts/dev-worker.sh`

```
  ┌──────────────────────────┐
  │   STARTUP                │
  │  Lock acquire   (L:286)  │
  │  Auth check     (L:347)  │
  │  Dev server     (L:354)  │
  │  Heartbeat bg   (L:71)   │
  └────────────┬─────────────┘
               ▼
  ┌──────────────────────────┐
  │   CLAIM TASK             │◄──────────────────────┐
  │  db_claim_next_task      │                       │
  │  Write current-task-N.md │                       │
  └────────────┬─────────────┘                       │
               │ (no tasks → dispatch project-driver │
               │              and exit loop)         │
               ▼                                     │
  ┌──────────────────────────┐                       │
  │   WORKTREE SETUP         │                       │
  │  Create/reuse branch     │                       │
  │  pnpm install            │                       │
  └────────────┬─────────────┘                       │
               ▼                                     │
  ┌──────────────────────────┐                       │
  │   AGENT EXECUTION        │                       │
  │  run_agent (Claude Code) │                       │
  │  Timeout: 45m            │                       │
  └─────┬──────────┬─────────┘                       │
     success     failure                             │
        │           │                                │
        │           └──► db_fail_task ──► next task ─┘
        ▼                                            │
  ┌──────────────────────────┐                       │
  │   QUALITY GATES          │                       │
  │  SKYNET_GATE_1..N        │                       │
  │  bash -n on .sh files    │                       │
  └─────┬──────────┬─────────┘                       │
     pass        fail                                │
        │           │                                │
        │           └──► db_fail_task ──► next task ─┘
        ▼                                            │
  ┌──────────────────────────┐                       │
  │   MERGE TO MAIN          │                       │
  │  acquire_merge_lock      │                       │
  │  git pull origin main    │                       │
  │  git merge branch        │                       │
  │  post-merge typecheck    │                       │
  │  git push                │                       │
  │  release_merge_lock      │                       │
  └─────┬──────────┬─────────┘                       │
     success     failure                             │
        │           │                                │
        │           └──► git revert + db_fail_task ──┘
        ▼
  ┌──────────────────────────┐
  │   COMPLETE               │
  │  db_complete_task        │
  │  db_export_state_files   │
  │  git commit state files  │
  │  git push                │
  └──────────────────────────┘
```

### Heartbeat vs Progress Epoch

| Signal | Writer | Interval | Watchdog check |
|--------|--------|----------|----------------|
| **Heartbeat** | Background subshell (`dev-worker.sh:72-79`) | Every 60s | `worker-N.heartbeat` file age > `SKYNET_STALE_MINUTES` |
| **Progress epoch** | Main loop (`db_set_worker_status`) | On state change | `workers.progress_epoch` column stale > `SKYNET_STALE_MINUTES` |

Heartbeat proves the process is alive. Progress epoch proves the main loop
is making forward progress. A worker with fresh heartbeat but stale progress
is **hung** (blocked in Claude Code or a gate).

---

## 3. Task-Fixer State Machine

File: `scripts/task-fixer.sh`

```
  ┌──────────────────────────┐
  │   STARTUP                │
  │  Lock acquire   (L:122)  │
  │  Auth check     (L:227)  │
  └────────────┬─────────────┘
               ▼
  ┌──────────────────────────┐
  │   COOLDOWN CHECK         │
  │  Last 5 attempts failed? │
  │  If yes → 30m cooldown   │
  │  and exit       (L:234)  │
  └────────────┬─────────────┘
               ▼
  ┌──────────────────────────┐
  │   CLAIM FAILURE          │
  │  db_claim_failure        │
  │  → status = fixing-{N}   │
  │  Max attempts? → blocked │
  └────────────┬─────────────┘
               │ (no failures → exit)
               ▼
  ┌──────────────────────────┐
  │   PREPARE CONTEXT        │
  │  Find original worker log│
  │  Extract git diff        │
  │  Build fixer prompt      │
  └────────────┬─────────────┘
               ▼
  ┌──────────────────────────┐
  │   WORKTREE SETUP         │
  │  Reuse branch or fresh   │
  │  Conflict check          │
  │  pnpm install            │
  └────────────┬─────────────┘
               ▼
  ┌──────────────────────────┐
  │   AGENT EXECUTION        │
  │  run_agent (fixer prompt)│
  │  Timeout: 45m            │
  │  Usage limit detection   │
  └─────┬──────────┬─────────┘
     success     failure
        │           │
        │           └──► attempts++ → exit (retry later)
        ▼
  ┌──────────────────────────┐
  │   QUALITY GATES          │
  │  Same as dev-worker      │
  └─────┬──────────┬─────────┘
     pass        fail
        │           │
        │           └──► attempts++ → exit (retry later)
        ▼
  ┌──────────────────────────┐
  │   MERGE TO MAIN          │
  │  Same as dev-worker      │
  │  (merge lock, pull,      │
  │   merge, typecheck, push)│
  └─────┬──────────┬─────────┘
     success     failure
        │           │
        │           └──► attempts++ → exit (retry later)
        ▼
  ┌──────────────────────────┐
  │   FIXED                  │
  │  db_fix_task             │
  │  db_export_state_files   │
  │  git commit + push       │
  └──────────────────────────┘
```

### Fix Attempt Progression

```
Attempt 1: failed → fixing-1 → (success → fixed) | (fail → failed, attempts=1)
Attempt 2: failed → fixing-1 → (success → fixed) | (fail → failed, attempts=2)
Attempt 3: failed → fixing-1 → (success → fixed) | (fail → blocked)
```

Note: `fixing-{N}` where N is the **fixer instance ID** (1–3), not the attempt number.

---

## 4. Watchdog Reconciliation Cycle

File: `scripts/watchdog.sh` — runs every `WATCHDOG_INTERVAL` (180s).

```
  ┌─ Crash Recovery ──────────────────────────────────────┐
  │  1. Kill stale worker/fixer processes  (L:116-191)    │
  │  2. Clean orphaned worktrees           (L:248-286)    │
  │  3. Unclaim orphaned tasks (>120s)     (L:302-320)    │
  │  4. Reset stale fixing-N tasks         (L:326-354)    │
  │  5. Clean dead merge locks             (L:356-371)    │
  └───────────────────────────────────────────────────────┘
           │
           ▼
  ┌─ Health & Validation ─────────────────────────────────┐
  │  6. SQLite integrity check             (L:373-384)    │
  │  7. Backlog validation                 (L:386-387)    │
  │  8. Auth pre-check (Claude + Codex)    (L:389-404)    │
  └───────────────────────────────────────────────────────┘
           │
           ▼
  ┌─ Stale Worker Detection ──────────────────────────────┐
  │  9. Kill heartbeat-stale workers       (L:434-515)    │
  │ 10. Kill hung workers (progress stale) (L:532-553)    │
  └───────────────────────────────────────────────────────┘
           │
           ▼
  ┌─ Data Maintenance ────────────────────────────────────┐
  │ 11. Auto-supersede redundant failures  (L:573-639)    │
  │ 11b. Auto-supersede merged branches    (L:640-680)    │
  │ 12. Archive old completions            (L:700-765)    │
  │ 13. Delete stale branches              (L:770-855)    │
  └───────────────────────────────────────────────────────┘
           │
           ▼
  ┌─ Dispatch (if auth ok & not paused) ──────────────────┐
  │ 14. Health score alerting              (L:811-874)     │
  │ 15. Smoke test (if enabled)            (L:876-909)     │
  │ 16. Spawn dev-workers (proportional)   (L:920-928)     │
  │ 17. Spawn task-fixers (proportional)   (L:930-965)     │
  │ 18. Spawn project-driver               (L:967-988)     │
  └────────────────────────────────────────────────────────┘
```

### Dispatch Rules

| Component | Condition to spawn instance N | Max |
|-----------|-------------------------------|-----|
| Dev-Worker N | `pending_tasks >= N` AND worker N is idle | `SKYNET_MAX_WORKERS` (4) |
| Task-Fixer N | `failed_pending >= N` AND fixer N is idle AND not in cooldown | `SKYNET_MAX_FIXERS` (3) |
| Project-Driver | `pending_tasks < DRIVER_BACKLOG_THRESHOLD` OR last run > 1h ago | 1 |

---

## 5. Lock Hierarchy

Locks are mkdir-based atomic mutexes with PID files for stale detection.

```
Priority (highest first):

  ┌─────────────────────────────────────────────────┐
  │  MERGE LOCK                                     │
  │  Path: /tmp/skynet-{project}-merge.lock         │
  │  Acquire: 60 retries × 0.5s = 30s max wait     │
  │  Stale: PID dead → immediate, age > 120s        │
  │  Holders: dev-worker, task-fixer (one at a time)│
  │  File: _locks.sh:11                             │
  └─────────────────────────────────────────────────┘
                      │
                      ▼
  ┌─────────────────────────────────────────────────┐
  │  BACKLOG LOCK                                   │
  │  Path: /tmp/skynet-{project}-backlog.lock       │
  │  Acquire: 50 retries × 0.1s = 5s max wait      │
  │  Stale: age > 30s                               │
  │  Holders: any script modifying backlog.md       │
  │  File: dev-worker.sh:94                         │
  └─────────────────────────────────────────────────┘
                      │
                      ▼
  ┌─────────────────────────────────────────────────┐
  │  FAILED LOCK                                    │
  │  Path: /tmp/skynet-{project}-failed.lock        │
  │  Acquire: 50 retries × 0.1s = 5s max wait      │
  │  Stale: age > 30s                               │
  │  Holders: task-fixer modifying failed-tasks.md  │
  │  File: task-fixer.sh:158                        │
  └─────────────────────────────────────────────────┘
```

### Singleton Locks (one-per-instance, no wait)

| Lock | Path | File |
|------|------|------|
| Watchdog | `/tmp/skynet-{project}-watchdog.lock` | `watchdog.sh:24` |
| Dev-Worker N | `/tmp/skynet-{project}-dev-worker-{N}.lock` | `dev-worker.sh:286` |
| Task-Fixer 1 | `/tmp/skynet-{project}-task-fixer.lock` | `task-fixer.sh:128` |
| Task-Fixer N (2+) | `/tmp/skynet-{project}-task-fixer-{N}.lock` | `task-fixer.sh:128` |
| Project-Driver | `/tmp/skynet-{project}-project-driver.lock` | `project-driver.sh` |

---

## 6. Guard Times

All configurable via env vars unless marked "hardcoded".

| Threshold | Default | Config | Purpose | File |
|-----------|---------|--------|---------|------|
| Worker heartbeat staleness | **45 min** | `SKYNET_STALE_MINUTES` | Kill worker if heartbeat file age exceeds this | `watchdog.sh:440` |
| Agent execution timeout | **45 min** | `SKYNET_AGENT_TIMEOUT_MINUTES` | Kill Claude Code if still running | `dev-worker.sh:584`, `task-fixer.sh:791` |
| Orphaned claim reconciliation | **120 sec** | hardcoded | Unclaim tasks claimed >120s ago with no active worker | `watchdog.sh:306` |
| Stale fixing-N reconciliation | **120 sec** | hardcoded | Reset fixing-N tasks >120s old when fixer is dead | `watchdog.sh:330` |
| Merge lock stale timeout | **120 sec** | hardcoded | Force-release merge lock if holder dead and lock age > 120s | `_locks.sh:41` |
| Backlog lock stale timeout | **30 sec** | hardcoded | Force-release backlog lock if age > 30s | `dev-worker.sh:103` |
| Failed lock stale timeout | **30 sec** | hardcoded | Force-release failed lock if age > 30s | `task-fixer.sh:165` |
| Merge lock max wait | **30 sec** | hardcoded (60 × 0.5s) | Give up acquiring merge lock | `_locks.sh:15` |
| Git push timeout | **30 sec** | `SKYNET_GIT_PUSH_TIMEOUT` | Timeout individual push attempts | `_config.sh:86` |
| Max fix attempts | **3** | `SKYNET_MAX_FIX_ATTEMPTS` | Block task after N failed fixes | `_config.sh:58` |
| Fixer cooldown | **30 min** | hardcoded (1800s) | Pause all fixers after 5 consecutive failures | `task-fixer.sh:259` |
| Heartbeat write interval | **60 sec** | hardcoded | Background subshell writes heartbeat | `dev-worker.sh:76` |
| Watchdog cycle interval | **180 sec** | `WATCHDOG_INTERVAL` | Main reconciliation loop period | `watchdog.sh:1016` |
| Completed archival | **7 days** | hardcoded | Archive completed entries older than 7 days | `watchdog.sh:649` |
| Archival threshold | **50 entries** | hardcoded | Only archive when completed.md > 50 entries | `watchdog.sh:648` |

### Why 120 seconds for orphaned claims?

The gap between `db_claim_next_task()` and `db_set_worker_status('in_progress')`
is normally 50–200ms (worktree setup, pnpm install). The 120s guard prevents the
watchdog from racing with a slow worker startup while still recovering genuinely
orphaned claims within 2 watchdog cycles (2 × 180s = 360s worst case).

---

## 7. SQLite as Source of Truth

All state mutations go through `_db.sh` functions. Markdown files (backlog.md,
completed.md, failed-tasks.md) are regenerated from SQLite via
`db_export_state_files()` (`_db.sh:747`) only at merge time for git history.

Key atomicity guarantees:
- **Task claiming**: `UPDATE ... WHERE status='pending'; SELECT changes();` — only one worker gets `changes()=1` (`_db.sh:205-215`)
- **Failure claiming**: Same atomic pattern (`_db.sh:330-341`)
- **WAL mode**: `PRAGMA journal_mode = WAL` allows concurrent reads + single writer
- **Busy timeout**: `PRAGMA busy_timeout = 5000` prevents immediate SQLITE_BUSY errors
