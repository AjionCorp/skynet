import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ""),
}));

import { existsSync, readdirSync, readFileSync } from "fs";
import { listSkillsCommand } from "../list-skills";

const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe("listSkillsCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // loadConfig returns valid config
    vi.doMock("../utils/loadConfig", () => ({
      loadConfig: () => ({
        SKYNET_PROJECT_NAME: "test-project",
        SKYNET_PROJECT_DIR: "/tmp/test",
        SKYNET_DEV_DIR: "/tmp/test/.dev",
      }),
    }));
  });

  it("shows message when skills directory does not exist", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      return false;
    });

    await listSkillsCommand({ dir: "/tmp/test" });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No skills directory found")
    );
  });

  it("shows message when skills directory is empty", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("skills")) return true;
      return false;
    });

    mockReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);

    await listSkillsCommand({ dir: "/tmp/test" });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No skills found")
    );
  });

  it("lists skills with frontmatter metadata", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("skills")) return true;
      return false;
    });

    mockReaddirSync.mockReturnValue([
      "auth-helper.md",
      "test-runner.md",
    ] as unknown as ReturnType<typeof readdirSync>);

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) {
        return 'export SKYNET_PROJECT_NAME="test-project"\nexport SKYNET_PROJECT_DIR="/tmp/test"\nexport SKYNET_DEV_DIR="/tmp/test/.dev"' as never;
      }
      if (path.includes("auth-helper")) {
        return `---
name: auth-helper
description: Authentication utilities
tags: FEAT,FIX
---

## Auth Helper

Instructions here.
` as never;
      }
      if (path.includes("test-runner")) {
        return `---
name: test-runner
description: Run project tests
tags:
---

## Test Runner

Instructions here.
` as never;
      }
      return "" as never;
    });

    await listSkillsCommand({ dir: "/tmp/test" });

    // Should show skill count
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Skills (2)")
    );

    // Should display each skill's info
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("auth-helper")
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("test-runner")
    );
  });

  it("handles skills without frontmatter", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("skills")) return true;
      return false;
    });

    mockReaddirSync.mockReturnValue([
      "plain-skill.md",
    ] as unknown as ReturnType<typeof readdirSync>);

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) {
        return 'export SKYNET_PROJECT_NAME="test-project"\nexport SKYNET_PROJECT_DIR="/tmp/test"\nexport SKYNET_DEV_DIR="/tmp/test/.dev"' as never;
      }
      return "## Plain Skill\n\nNo frontmatter here.\n" as never;
    });

    await listSkillsCommand({ dir: "/tmp/test" });

    // Should still list the skill using filename as name
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("plain-skill")
    );
  });

  it("filters out non-markdown files", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith("skills")) return true;
      return false;
    });

    mockReaddirSync.mockReturnValue([
      "valid-skill.md",
      ".DS_Store",
      "notes.txt",
    ] as unknown as ReturnType<typeof readdirSync>);

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) {
        return 'export SKYNET_PROJECT_NAME="test-project"\nexport SKYNET_PROJECT_DIR="/tmp/test"\nexport SKYNET_DEV_DIR="/tmp/test/.dev"' as never;
      }
      return `---
name: valid-skill
description: A valid skill
tags: FEAT
---
` as never;
    });

    await listSkillsCommand({ dir: "/tmp/test" });

    // Should only show 1 skill (the .md file)
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Skills (1)")
    );
  });
});
