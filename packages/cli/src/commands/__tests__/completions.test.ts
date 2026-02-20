import { describe, it, expect, vi, beforeEach } from "vitest";
import { completionsCommand } from "../completions";

// All registered commands from the COMMANDS record in completions.ts
const EXPECTED_COMMANDS = [
  "init",
  "setup-agents",
  "start",
  "stop",
  "pause",
  "resume",
  "status",
  "doctor",
  "logs",
  "version",
  "add-task",
  "run",
  "dashboard",
  "reset-task",
  "cleanup",
  "watch",
  "upgrade",
  "metrics",
  "export",
  "import",
  "config",
  "completions",
  "test-notify",
];

describe("completionsCommand", () => {
  let stdoutOutput: string;
  let stderrOutput: string;
  const mockStdoutWrite = vi.fn();
  const mockStderrWrite = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutOutput = "";
    stderrOutput = "";

    // Mock process.stdout.write and process.stderr.write to capture output
    mockStdoutWrite.mockImplementation((chunk: string) => {
      stdoutOutput += chunk;
      return true;
    });
    mockStderrWrite.mockImplementation((chunk: string) => {
      stderrOutput += chunk;
      return true;
    });

    vi.spyOn(process.stdout, "write").mockImplementation(mockStdoutWrite);
    vi.spyOn(process.stderr, "write").mockImplementation(mockStderrWrite);

    // console.log/error write to stdout/stderr respectively
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutOutput += args.join(" ") + "\n";
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput += args.join(" ") + "\n";
    });

    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  describe("bash completions", () => {
    it("contains compgen -W with all registered command names", async () => {
      await completionsCommand("bash");

      // The compgen -W line should contain all command names
      for (const cmd of EXPECTED_COMMANDS) {
        expect(stdoutOutput).toContain(cmd);
      }
      // Verify the compgen -W pattern that lists all commands
      expect(stdoutOutput).toMatch(/compgen -W/);
    });

    it("contains _skynet() function definition and COMPREPLY", async () => {
      await completionsCommand("bash");

      expect(stdoutOutput).toContain("_skynet()");
      expect(stdoutOutput).toContain("COMPREPLY");
    });

    it("contains complete registration for skynet", async () => {
      await completionsCommand("bash");

      expect(stdoutOutput).toContain("complete -F _skynet skynet");
    });
  });

  describe("zsh completions", () => {
    it("starts with #compdef skynet and contains _arguments", async () => {
      await completionsCommand("zsh");

      expect(stdoutOutput).toMatch(/^#compdef skynet/);
      expect(stdoutOutput).toContain("_arguments");
    });

    it("includes all registered commands", async () => {
      await completionsCommand("zsh");

      for (const cmd of EXPECTED_COMMANDS) {
        expect(stdoutOutput).toContain(cmd);
      }
    });

    it("includes command descriptions", async () => {
      await completionsCommand("zsh");

      expect(stdoutOutput).toContain("Initialize Skynet pipeline");
      expect(stdoutOutput).toContain("Show pipeline status summary");
      expect(stdoutOutput).toContain("Generate shell completions");
    });
  });

  describe("invalid shell", () => {
    it("produces error output and exits with non-zero for unsupported shell", async () => {
      await expect(completionsCommand("fish")).rejects.toThrow("process.exit");

      expect(stderrOutput).toContain("Unknown shell: fish");
      expect(stderrOutput).toContain("Supported shells: bash, zsh");
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe("installation hint", () => {
    it("writes bash installation hint to stderr", async () => {
      await completionsCommand("bash");

      expect(stderrOutput).toContain("~/.bashrc");
      expect(stderrOutput).toContain("eval");
    });

    it("writes zsh installation hint to stderr", async () => {
      await completionsCommand("zsh");

      expect(stderrOutput).toContain("~/.zshrc");
      expect(stderrOutput).toContain("eval");
    });
  });
});
