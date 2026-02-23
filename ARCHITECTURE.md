# Architecture

Reference for contributors. See `README.md` for setup and usage.

## Pipeline Overview

```
mission.md ──> project-driver ──> backlog.md
                                      │
                                  watchdog (every 3 min)
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                 │
               dev-worker 1     dev-worker 2     dev-worker N
                    │
         ┌─────────┴──────────┐
         │    Worker Lifecycle │
         │                    │
         │  1. Claim task     │   ← atomic SQLite transition: pending → claimed
         │  2. Create worktree│   ← git worktree add /tmp/skynet-{proj}-worktree-wN
         │  3. Invoke agent   │   ← Claude Code / Codex / Gemini via plugin
         │  4. Run gates      │   ← SKYNET_GATE_1 .. SKYNET_GATE_N in sequence
         │  5. Merge to main  │   ← under merge mutex lock
         │  6. Cleanup        │   ← remove worktree + branch
         └────────────────────┘
                    │
           on failure → failed-tasks.md → task-fixer (retries up to 3x)
```

## SQLite + Markdown Dual Storage

**SQLite** (`.dev/skynet.db`) is the source of truth. It provides ACID
transactions, WAL-mode concurrency, and atomic status transitions that prevent
race conditions between parallel workers.

**Markdown files** (`backlog.md`, `completed.md`, `failed-tasks.md`) are
regenerated from SQLite for two reasons:
1. **Human readability** -- operators can inspect pipeline state with `cat`
2. **Git history** -- committed markdown provides a change audit trail

Bash scripts write to SQLite first, then export to markdown. Dashboard handlers
read from SQLite with a file-based fallback for backward compatibility.

## Worktree Isolation

Each worker operates in its own git worktree at
`/tmp/skynet-{project}-worktree-wN`. Worktrees are preferred over branches
because parallel workers need **separate working directories** -- you cannot
have two processes running `pnpm install` and `pnpm typecheck` against the same
checkout simultaneously. Worktrees provide full filesystem isolation with shared
git object storage (no clone overhead).

Workers get per-worker port offsets (`SKYNET_DEV_PORT + N - 1`) to avoid
dev-server collisions.

## Lock Patterns

### mkdir Atomic Locks

All critical sections use `mkdir` for mutual exclusion. `mkdir` is an atomic
kernel operation on all Unix systems -- it either succeeds (lock acquired) or
fails (already held). This is more reliable than file-based checks which have
a TOCTOU race window.

```bash
# Acquire
mkdir "$LOCK_DIR" 2>/dev/null || { echo "locked"; exit 1; }
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

# Check for stale lock
pid=$(cat "$LOCK_DIR/pid")
kill -0 "$pid" 2>/dev/null || { rm -rf "$LOCK_DIR"; }
```

### Lock Types

| Lock | Path | Purpose |
|------|------|---------|
| Watchdog | `{prefix}-watchdog.lock/` | Singleton watchdog process |
| Worker | `{prefix}-dev-worker-N.lock/` | One instance per worker slot |
| Fixer | `{prefix}-task-fixer-N.lock/` | One instance per fixer slot |
| Merge | `{prefix}-merge.lock/` | Serializes git merges to main |
| Backlog | `{prefix}-backlog.lock/` | Protects backlog read-modify-write |

All locks include a `pid` file for stale-lock detection. The EXIT trap ensures cleanup on normal exit and signals (SIGTERM, SIGINT).

## Agent Plugin System

Agents are interchangeable via plugins in `scripts/agents/`. Each plugin
exports two functions:

```bash
agent_check()              # Return 0 if agent binary is available
agent_run "prompt" "log"   # Execute agent, return exit code
```

**Built-in plugins:** `claude.sh`, `codex.sh`, `gemini.sh`, `echo.sh` (dry-run).

**Auto-mode fallback chain:** When `SKYNET_AGENT_PLUGIN=auto` (default), the
system tries Claude, then Codex, then Gemini, using the first available agent.
Custom plugins can be specified by absolute path.

Agent invocations are wrapped in a portable timeout (`_agent_exec`) that works
on both Linux (GNU `timeout`) and macOS (perl alarm), defaulting to 45 minutes.

## Quality Gates

Gates are numbered environment variables evaluated in sequence before any merge:

```bash
SKYNET_GATE_1="pnpm typecheck"
SKYNET_GATE_2="pnpm lint"
SKYNET_GATE_3="pnpm test --run"
```

The worker loops from `SKYNET_GATE_1` upward until it finds an empty variable.
If any gate exits non-zero, the task is marked failed and routed to the
task-fixer for retry with full error context (gate output, diff, logs).

Post-merge smoke tests (`SKYNET_POST_MERGE_SMOKE`) run after merge and
auto-revert the commit if they fail, preventing broken main.

## Watchdog Self-Healing

The watchdog runs every `SKYNET_WATCHDOG_INTERVAL` seconds (default 180) and
performs three-phase crash recovery:

### Phase 1: Stale Lock Detection

Iterates all known lock directories. For each lock, reads the PID file and
checks if the process is alive (`kill -0`). Stale locks (dead PID) are removed.
Hung workers (alive but past `SKYNET_STALE_MINUTES`) receive SIGTERM, then
SIGKILL after 10 seconds.

### Phase 2: Orphaned Task Recovery

Scans for tasks in `claimed` status whose worker is no longer running. These
orphaned claims are atomically reset to `pending` in SQLite so they can be
picked up by the next available worker. Both SQLite and file-based checks run
for backward compatibility.

### Phase 3: Worktree Cleanup

Inspects each worktree directory. If a worktree exists but its owning worker is
not running, the watchdog kills orphan processes inside it, removes the worktree
via `git worktree remove --force`, and cleans up the branch.

Additional per-cycle duties: dispatch idle workers, rotate logs, auto-supersede
duplicate tasks, clean stale branches, and emit health-score alerts.
