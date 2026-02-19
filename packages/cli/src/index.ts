#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { setupAgentsCommand } from "./commands/setup-agents.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";

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
  .description("Generate and install macOS LaunchAgent plists")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .option("--dry-run", "Print plists without installing")
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

program.parse();
