# .dev/ Directory — Skynet Ops Guide

This directory contains the state files and scripts for your Skynet autonomous development pipeline. Below is a quick-reference for common operations.

## Quick Status Check

```bash
# See what the pipeline is doing right now
cat .dev/current-task.md

# See pending tasks
cat .dev/backlog.md

# See what's been completed
cat .dev/completed.md

# Check for blockers
cat .dev/blockers.md

# Check for failures
cat .dev/failed-tasks.md

# Check data sync status
cat .dev/sync-health.md
```

## Worker Management

### Check which workers are loaded
```bash
launchctl list | grep skynet
```

### Manually trigger a worker
```bash
# Kick a specific worker to run immediately
launchctl kickstart gui/$(id -u)/com.skynet.<project>.dev-worker
launchctl kickstart gui/$(id -u)/com.skynet.<project>.watchdog
launchctl kickstart gui/$(id -u)/com.skynet.<project>.project-driver
```

### Stop / start workers
```bash
# Unload a specific worker (stops it)
launchctl bootout gui/$(id -u)/com.skynet.<project>.dev-worker

# Reload a worker
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.skynet.<project>.dev-worker.plist

# Stop ALL skynet workers
skynet stop

# Start ALL skynet workers
skynet start
```

## Reading Logs

Worker logs are written to `.dev/scripts/`:

```bash
# Tail the dev-worker log
tail -f .dev/scripts/dev-worker.log

# Tail the watchdog log
tail -f .dev/scripts/watchdog.log

# Search for errors across all logs
grep -i "error\|fatal\|fail" .dev/scripts/*.log
```

## Common Operations

### Add a task manually
Edit `.dev/backlog.md` and add a line at the desired priority position:
```markdown
- [ ] [FEAT] Task title — description of what to implement
```

Tags: `FEAT` (feature), `FIX` (bug fix), `INFRA` (infrastructure), `TEST` (testing)

### Mark a task as blocked
Edit `.dev/blockers.md` to add the blocker:
```markdown
## Blocker Title
- **Source:** dev-worker / manual
- **Date:** 2024-01-15
- **Details:** Description of what's blocking progress
```

### Clear a stale task
If `current-task.md` shows a task that's stuck:
1. Check the dev-worker log for errors
2. Reset the file: set status to `idle`
3. The task will return to the backlog on the next watchdog cycle

### Force re-run project planning
```bash
launchctl kickstart gui/$(id -u)/com.skynet.<project>.project-driver
```

### Check auth status
```bash
# See if auth-failed flag exists
ls /tmp/skynet-<project>-auth-failed 2>/dev/null && echo "AUTH FAILED" || echo "Auth OK"

# Force auth refresh
launchctl kickstart gui/$(id -u)/com.skynet.<project>.auth-refresh
```

## File Reference

| File | Committed | Purpose |
|------|-----------|---------|
| `skynet.config.sh` | No (gitignored) | Machine-specific paths, ports, secrets |
| `skynet.project.sh` | Yes | Project vision, worker context, sync endpoints |
| `backlog.md` | Yes | Prioritized task queue |
| `current-task.md` | Yes | Active task status |
| `completed.md` | Yes | Completed task log |
| `failed-tasks.md` | Yes | Failed task log with error details |
| `blockers.md` | Yes | Active blockers |
| `sync-health.md` | Yes | Data sync endpoint status |
| `pipeline-status.md` | Yes | Architecture docs and Mermaid diagram |
| `scripts/` | Yes | Worker scripts (symlinked from skynet) |
| `scripts/*.log` | No (gitignored) | Worker output logs |

## Troubleshooting

### Workers not running
1. Check LaunchAgents are loaded: `launchctl list | grep skynet`
2. Check for auth failure: `ls /tmp/skynet-*-auth-failed`
3. Check logs: `tail -20 .dev/scripts/watchdog.log`

### Tasks stuck in "claimed" state
The watchdog should auto-clear these after `SKYNET_STALE_MINUTES` (default: 45). To manually clear:
1. Edit `backlog.md`: change `[>]` back to `[ ]`
2. Reset `current-task.md` status to `idle`

### Claude Code errors
1. Check auth: `claude --version` (should work without errors)
2. Check token cache: `ls /tmp/skynet-*-claude-token`
3. Force auth refresh and check the log

### Dev server not starting
1. Verify `SKYNET_DEV_SERVER_CMD` in `skynet.config.sh`
2. Try running it manually: `cd <project-dir> && pnpm dev`
3. Check if the port is already in use: `lsof -i :3000`
