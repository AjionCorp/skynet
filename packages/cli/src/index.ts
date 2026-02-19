#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { setupAgentsCommand } from "./commands/setup-agents.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";
import { doctorCommand } from "./commands/doctor.js";
import { versionCommand } from "./commands/version.js";

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
  .command("version")
  .description("Show CLI version and check for updates")
  .action(versionCommand);

program.parse();
