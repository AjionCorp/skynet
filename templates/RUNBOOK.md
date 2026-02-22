# Skynet Operational Runbook

## Monitoring Thresholds

| Metric | Normal | Warning | Action Required |
|--------|--------|---------|-----------------|
| Health score | 80-100 | 50-79 | < 50 |
| Pending failed tasks | 0-2 | 3-5 | > 5 |
| Task duration | < 15 min | 15-30 min | > 30 min (likely stuck) |
| Backlog size | < 20 | 20-50 | > 50 (driver generating too fast) |
| Worker heartbeat age | < 2 min | 2-5 min | > 5 min (stale) |

## Common Issues

### Worker stuck / not progressing

**Symptoms:** Heartbeat age > 5 min, task status stays "in_progress"

**Diagnosis:**
```bash
skynet status --json | jq '.workers'
cat .dev/scripts/dev-worker-N.log | tail -50
```

**Fix:**
```bash
# Graceful stop (preferred)
skynet stop

# Force kill a specific worker
kill $(cat /tmp/skynet-PROJECT-dev-worker-N.lock/pid)
rm -rf /tmp/skynet-PROJECT-dev-worker-N.lock
```

The watchdog will automatically unclaim the task on next cycle.

### Backlog lock stale

**Symptoms:** Tasks can't be claimed, "Could not acquire backlog lock" in logs

**Diagnosis:**
```bash
ls -la /tmp/skynet-PROJECT-backlog.lock
```

**Fix:**
```bash
rm -rf /tmp/skynet-PROJECT-backlog.lock
```

The lock is mkdir-based. Removing the directory releases it immediately.

### Merge lock stale

**Symptoms:** "Could not acquire merge lock" in worker/fixer logs

**Fix:**
```bash
rm -rf /tmp/skynet-PROJECT-merge.lock
```

### High failure rate (> 5 pending failures)

**Symptoms:** Many tasks in failed-tasks.md with status "pending"

**Diagnosis:**
```bash
skynet status
cat .dev/failed-tasks.md
```

**Fix options:**
1. Let task-fixer handle them (automatic, up to MAX_FIX_ATTEMPTS)
2. Reset specific tasks: `skynet reset-task "task name substring"`
3. Mark as blocked: manually edit failed-tasks.md, change status to "blocked"
4. Investigate root cause in worker logs

### Auth expired (Claude Code / Codex)

**Symptoms:** Workers exit immediately, "auth failed" or "usage limit" in logs

**Diagnosis:**
```bash
skynet status --json | jq '.auth'
cat /tmp/skynet-PROJECT-auth-failed  # if exists, auth is broken
```

**Fix:**
```bash
# Re-authenticate Claude Code
claude auth login

# Clear the failure flag
rm /tmp/skynet-PROJECT-auth-failed

# Restart watchdog
bash .dev/scripts/watchdog.sh
```

### Git in bad state (detached HEAD, merge conflicts on main)

**Symptoms:** Workers fail with git errors, "MERGE_HEAD exists"

**Diagnosis:**
```bash
cd /path/to/project
git status
git log --oneline -5
```

**Fix:**
```bash
# Abort any in-progress merge
git merge --abort 2>/dev/null || true

# Ensure on main branch
git checkout main
git pull origin main

# Clean orphaned worktrees
git worktree prune
```

## Emergency Procedures

### Kill all workers immediately

```bash
# Graceful (preferred)
skynet stop

# Force kill everything
pkill -f "skynet.*dev-worker"
pkill -f "skynet.*task-fixer"
pkill -f "skynet.*watchdog"

# Clean up all lock files
rm -rf /tmp/skynet-PROJECT-*.lock
```

### Reset pipeline state

```bash
# Pause pipeline first
skynet pause "emergency reset"

# Clear all claims (reset [>] to [ ])
# The watchdog does this automatically, but for immediate effect:
sed -i '' 's/- \[>\]/- [ ]/g' .dev/backlog.md

# Clear stale lock files
rm -rf /tmp/skynet-PROJECT-*.lock

# Resume
skynet resume
```

### Recover from corrupted state files

State files are tracked in git. To restore from the last known good state:

```bash
# Check what changed
git diff .dev/backlog.md
git diff .dev/failed-tasks.md

# Restore specific file from last commit
git checkout HEAD -- .dev/backlog.md

# Or restore all state files
git checkout HEAD -- .dev/backlog.md .dev/completed.md .dev/failed-tasks.md .dev/blockers.md
```

### Export state before destructive changes

```bash
skynet export --output backup.json
# Later, restore with:
skynet init --from-snapshot backup.json
```

## Routine Maintenance

### Weekly

- Check `skynet status` for health score and pending failures
- Review `.dev/blockers.md` for tasks needing human attention
- Run `skynet cleanup` to prune merged branches

### Monthly

- Rotate Telegram bot token if exposed
- Review `.dev/completed.md` size (archive if > 500 entries)
- Run `git gc` to clean up git objects
- Check disk space: `df -h /tmp` and `du -sh .dev/`

### After updates

```bash
# After pulling new skynet code
skynet config migrate     # add new config variables
skynet doctor             # verify setup
pnpm typecheck            # verify no type errors
```
