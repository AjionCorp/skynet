#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { setupAgentsCommand } from "./commands/setup-agents.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";
import { doctorCommand } from "./commands/doctor.js";
import { logsCommand } from "./commands/logs.js";
import { versionCommand } from "./commands/version.js";
import { addTaskCommand } from "./commands/add-task.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { resetTaskCommand } from "./commands/reset-task.js";
import { cleanupCommand } from "./commands/cleanup.js";
import { runCommand } from "./commands/run.js";
import { pauseCommand } from "./commands/pause.js";
import { resumeCommand } from "./commands/resume.js";
import { configListCommand, configGetCommand, configSetCommand } from "./commands/config.js";
import { upgradeCommand } from "./commands/upgrade.js";

const program = new Command();

program
  .name("skynet")
  .description("AI-powered development pipeline powered by Claude Code")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize Skynet pipeline in the current project")
  .option("--name <name>", "Project name")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .option("--copy-scripts", "Copy scripts instead of symlinking")
  .option("--non-interactive", "Skip all interactive prompts (use defaults)")
  .action(initCommand);

program
  .command("setup-agents")
  .description("Install scheduled agents (launchd on macOS, cron on Linux)")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .option("--dry-run", "Print config without installing")
  .option("--cron", "Force cron mode (default on Linux, optional on macOS)")
  .option("--uninstall", "Remove all installed skynet agents")
  .action(setupAgentsCommand);

program
  .command("start")
  .description("Start the Skynet pipeline (load agents or launch watchdog)")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .action(startCommand);

program
  .command("stop")
  .description("Stop all running Skynet workers and unload agents")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .action(stopCommand);

program
  .command("status")
  .description("Show pipeline status summary")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .action(statusCommand);

program
  .command("doctor")
  .description("Run diagnostics on the Skynet pipeline")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .action(doctorCommand);

program
  .command("logs")
  .description("View pipeline log files")
  .argument("[type]", "Log type: worker, fixer, watchdog, health-check")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .option("--id <n>", "Worker ID (for worker logs, default: 1)")
  .option("--tail <n>", "Number of lines to show (default: 50)")
  .option("--follow", "Follow log output (stream new lines)")
  .action(logsCommand);

program
  .command("version")
  .description("Show CLI version and check for updates")
  .action(versionCommand);

program
  .command("add-task")
  .description("Add a new task to the backlog")
  .argument("<title>", "Task title")
  .option("--tag <tag>", "Task tag (e.g. FEAT, FIX, INFRA, TEST)", "FEAT")
  .option("--description <description>", "Task description")
  .option("--position <position>", "Insert position: top or bottom", "top")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .action(addTaskCommand);

program
  .command("run")
  .description("Run a single task one-shot (without adding to backlog)")
  .argument("<task>", "Task description (e.g. \"Implement feature X\")")
  .option("--agent <agent>", "Agent plugin to use (claude, codex, or path)")
  .option("--gate <gate>", "Quality gate to run (e.g. typecheck, or a raw command)")
  .option("--worker <n>", "Worker ID to use (default: 99)", "99")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .action(runCommand);

program
  .command("dashboard")
  .description("Launch the Skynet admin dashboard")
  .option("--port <port>", "Port to run the dashboard on", "3100")
  .action(dashboardCommand);

program
  .command("reset-task")
  .description("Reset a failed task back to pending")
  .argument("<title>", "Task title substring to match")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .option("--force", "Skip confirmation when deleting failed branch")
  .action(resetTaskCommand);

program
  .command("cleanup")
  .description("Clean up merged and orphaned dev/* branches and prune worktrees")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .option("--force", "Actually delete branches (default: dry-run)")
  .action(cleanupCommand);

program
  .command("pause")
  .description("Pause the Skynet pipeline (workers exit at next checkpoint)")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .action(pauseCommand);

program
  .command("resume")
  .description("Resume a paused Skynet pipeline")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .action(resumeCommand);

program
  .command("upgrade")
  .description("Upgrade skynet-cli to the latest version")
  .option("--check", "Only check if an update is available (dry-run)")
  .action(upgradeCommand);

const configCmd = program
  .command("config")
  .description("View and edit pipeline configuration")
  .option("--dir <dir>", "Project directory (default: cwd)");

configCmd
  .command("list", { isDefault: true })
  .description("List all configuration variables (default)")
  .action(async () => {
    await configListCommand(configCmd.opts());
  });

configCmd
  .command("get")
  .description("Get a single configuration variable")
  .argument("<key>", "Variable name (e.g. SKYNET_MAX_WORKERS)")
  .action(async (key: string) => {
    await configGetCommand(key, configCmd.opts());
  });

configCmd
  .command("set")
  .description("Set a configuration variable")
  .argument("<key>", "Variable name")
  .argument("<value>", "New value")
  .action(async (key: string, value: string) => {
    await configSetCommand(key, value, configCmd.opts());
  });

program.parse();
