import { describe, it, expect, vi, beforeEach } from "vitest";

const CONFIG_CONTENT =
  'export SKYNET_PROJECT_NAME="test-project"\nexport SKYNET_PROJECT_DIR="/tmp/test"\nexport SKYNET_DEV_DIR="/tmp/test/.dev"';

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => CONFIG_CONTENT),
  existsSync: vi.fn(() => false),
}));

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { addSkillCommand } from "../add-skill";

const mockMkdirSync = vi.mocked(mkdirSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);

describe("addSkillCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default: config exists, skill does not
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      return false;
    });

    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      return "" as never;
    });
  });

  it("creates skill markdown file with correct frontmatter", async () => {
    await addSkillCommand("my-skill", { dir: "/tmp/test" });

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("skills"),
      { recursive: true }
    );

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("my-skill.md"),
      expect.stringContaining("name: my-skill"),
      "utf-8"
    );
  });

  it("normalizes skill name to lowercase with hyphens", async () => {
    await addSkillCommand("My Cool Skill", { dir: "/tmp/test" });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("my-cool-skill.md"),
      expect.stringContaining("name: my-cool-skill"),
      "utf-8"
    );
  });

  it("includes tags in frontmatter when provided", async () => {
    await addSkillCommand("auth-helper", {
      dir: "/tmp/test",
      tags: "feat,fix",
    });

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    expect(content).toContain("tags: FEAT,FIX");
  });

  it("includes custom description in frontmatter", async () => {
    await addSkillCommand("test-skill", {
      dir: "/tmp/test",
      description: "Helps with testing",
    });

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    expect(content).toContain("description: Helps with testing");
  });

  it("generates title-cased heading from skill name", async () => {
    await addSkillCommand("my-cool-skill", { dir: "/tmp/test" });

    const content = mockWriteFileSync.mock.calls[0][1] as string;
    expect(content).toContain("## My Cool Skill");
  });

  it("rejects empty skill name", async () => {
    await expect(addSkillCommand("", { dir: "/tmp/test" })).rejects.toThrow(
      "process.exit"
    );

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Skill name is required")
    );
  });

  it("rejects invalid skill name characters", async () => {
    await expect(
      addSkillCommand("my_skill!", { dir: "/tmp/test" })
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("lowercase alphanumeric with hyphens")
    );
  });

  it("rejects overwrite without --force", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith(".md")) return true; // skill file exists
      return false;
    });

    await expect(
      addSkillCommand("existing-skill", { dir: "/tmp/test" })
    ).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("already exists")
    );
  });

  it("allows overwrite with --force", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true;
      if (path.endsWith(".md")) return true; // skill file exists
      return false;
    });

    await addSkillCommand("existing-skill", {
      dir: "/tmp/test",
      force: true,
    });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("existing-skill.md"),
      expect.any(String),
      "utf-8"
    );
  });
});
