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
  .action(initCommand);

program
  .command("setup-agents")
  .description("Install scheduled agents (launchd on macOS, cron on Linux)")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .option("--dry-run", "Print config without installing")
  .option("--cron", "Force cron mode (default on Linux, optional on macOS)")
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

program.parse();
