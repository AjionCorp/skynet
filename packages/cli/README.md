# @ajioncorp/skynet-cli

CLI for Skynet — autonomous AI development pipeline.

## Installation

```bash
npm install -g @ajioncorp/skynet-cli
```

## Quick Start

```bash
skynet init --name my-project
skynet setup-agents
skynet start
skynet watch
```

## Commands

| Command | Description |
|---------|-------------|
| `skynet init` | Initialize Skynet pipeline in the current project |
| `skynet setup-agents` | Install scheduled agents (launchd on macOS, cron on Linux) |
| `skynet start` | Start the pipeline (load agents or launch watchdog) |
| `skynet stop` | Stop all running workers and unload agents |
| `skynet pause` | Pause the pipeline (workers exit at next checkpoint) |
| `skynet resume` | Resume a paused pipeline |
| `skynet status` | Show pipeline status summary |
| `skynet doctor` | Run diagnostics on the pipeline |
| `skynet logs` | View pipeline log files |
| `skynet version` | Show CLI version and check for updates |
| `skynet add-task` | Add a new task to the backlog |
| `skynet run` | Run a single task one-shot (without the backlog) |
| `skynet dashboard` | Launch the admin dashboard |
| `skynet reset-task` | Reset a failed task back to pending |
| `skynet cleanup` | Clean up merged dev branches and prune worktrees |
| `skynet watch` | Real-time terminal dashboard for monitoring |
| `skynet upgrade` | Upgrade skynet-cli to the latest version |
| `skynet metrics` | Show pipeline performance analytics |
| `skynet export` | Export pipeline state as a JSON snapshot |
| `skynet config` | View and edit pipeline configuration |
| `skynet import` | Restore pipeline state from snapshot |
| `skynet completions` | Generate shell completions for bash/zsh |

## Configuration

Pipeline settings live in `.dev/skynet.config.sh`. Key variables:

| Variable | Description |
|----------|-------------|
| `SKYNET_MAX_WORKERS` | Maximum number of concurrent dev workers |
| `SKYNET_STALE_MINUTES` | Minutes before a running task is considered stale |
| `SKYNET_AGENT_PLUGIN` | Agent backend to use (e.g. `claude-code`) |
| `SKYNET_GATE_N` | Quality gate level (1 = typecheck, 2 = tests, 3 = lint) |

Use `skynet config list` to view current values, or `skynet config set <key> <value>` to update them.

## Dashboard

```bash
skynet dashboard
```

Launches the Skynet admin UI on **port 3100** with real-time worker status, task history, and pipeline analytics.

## Links

- [Main repository README](../../README.md)
- [Contributing guide](../../CONTRIBUTING.md)
