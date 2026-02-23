# Operational Runbook

Common failure scenarios and resolution procedures for the Skynet pipeline.

## 1. Auth Expired (Claude / Codex / Gemini)

**Symptoms**: Telegram "AUTH DOWN" alert, watchdog logs "not authenticated", all workers idle.

**Resolution**:
- **Claude**: Run `claude` and follow `/login` prompts. `auth-refresh.sh` handles token refresh every 30 min; full re-login is needed when the refresh token expires.
- **Codex**: Run `codex` to login via ChatGPT, or set `OPENAI_API_KEY`.
- **Gemini**: Set `GEMINI_API_KEY` or run `gcloud auth application-default login`.

Auth is checked every watchdog cycle (default 3 min). On recovery, a "RESTORED" alert fires and the blocker is auto-removed.

## 2. Merge Lock Stuck

**Symptoms**: Workers complete tasks but never merge. Logs show "merge lock held".

**Resolution**:
```bash
cat /tmp/skynet-{project}-merge.lock/pid    # check holder
kill -0 <pid> || rm -rf /tmp/skynet-{project}-merge.lock  # remove if dead
```
The watchdog detects dead-PID merge locks each cycle and removes them automatically.

## 3. Worker Hung / Stale

**Symptoms**: Heartbeat older than `SKYNET_STALE_MINUTES` (default 45 min). Dashboard shows worker stuck.

**Watchdog detection**: Reads `worker-N.heartbeat` epoch files. If stale, sends SIGTERM (SIGKILL after 10s), removes lock, unclaims task, cleans worktree.

**Manual intervention**:
```bash
cat /tmp/skynet-{project}-dev-worker-N.lock/pid
kill <pid>
rm -rf /tmp/skynet-{project}-dev-worker-N.lock
git worktree remove .dev/worktrees/wN --force
skynet doctor --fix
```

## 4. Post-Merge Typecheck Failed

**Symptoms**: Telegram smoke test failure alert. `pipeline-paused` appears after 2 consecutive failures.

**Auto-revert**: When `SKYNET_POST_MERGE_SMOKE=true`, quality gates run against main post-merge. On failure, the merge commit is reverted automatically.

**Manual action** (after auto-pause): Fix the issue on main, then:
```bash
skynet resume                  # or: rm .dev/pipeline-paused
```
Disable temporarily: `skynet config set SKYNET_POST_MERGE_SMOKE false`

## 5. SQLite Corruption

**Symptoms**: Watchdog logs "SQLite database failed integrity check". Telegram corruption alert.

**Auto-restore**: Watchdog runs `PRAGMA quick_check` each cycle. On corruption, restores from the newest daily backup in `.dev/db-backups/` (7-day retention, created via `sqlite3 .backup`).

**Manual recovery**:
```bash
sqlite3 .dev/skynet.db "PRAGMA quick_check;"
ls -1t .dev/db-backups/skynet.db.*           # list backups
cp .dev/db-backups/skynet.db.YYYYMMDD .dev/skynet.db
```
If all backups are corrupted, delete the DB. The pipeline recreates it from markdown files on next run.

## 6. Disk Space Full

**Symptoms**: Workers fail with write errors, git operations fail, SQLite errors.

The watchdog runs `clean-logs.sh` each cycle (trims to 24h) and archives completed tasks older than 7 days.

```bash
skynet cleanup                              # automated cleanup
rm -rf .dev/worktrees/w* && git worktree prune  # worktrees
rm .dev/db-backups/skynet.db.2026*          # old DB backups
find /tmp -name "skynet-*" -mtime +7 -delete    # stale temp files
```

## 7. All Agents Unavailable

**Symptoms**: Watchdog logs "No AI agent available". No workers dispatched despite pending tasks.

In auto-mode, `run_agent()` tries Claude, Codex, then Gemini. If all fail, tasks are marked failed. The watchdog skips dispatch when `agent_auth_ok=false`.

**Resolution**:
1. Check agents: `claude --version`, `codex --version`, `gemini --version`
2. Re-authenticate whichever is available (see scenario 1)
3. Temporary dry-run: `skynet config set SKYNET_AGENT_PLUGIN echo`
4. Workers resume automatically once any agent passes auth

## 8. Task Stuck in "claimed" Forever

**Symptoms**: Task shows `claimed` but no worker is processing it. Backlog shows `[>]` with no progress.

**Watchdog reconciliation**: Queries SQLite for `claimed` tasks where the worker is dead or working on a different task. Claims older than `SKYNET_ORPHAN_CUTOFF_SECONDS` (default 120s) are reset to `pending`.

**Manual reset**:
```bash
skynet reset-task "task title" --force
# Or directly:
sqlite3 .dev/skynet.db "UPDATE tasks SET status='pending', worker_id=NULL WHERE title='...';"
```
The watchdog auto-recovers within one cycle (default 3 min).
