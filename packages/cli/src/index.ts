#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { setupAgentsCommand } from "./commands/setup-agents.js";
import { statusCommand } from "./commands/status.js";

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
  .command("status")
  .description("Show pipeline status summary")
  .option("--dir <dir>", "Project directory (default: cwd)")
  .action(statusCommand);

program.parse();
