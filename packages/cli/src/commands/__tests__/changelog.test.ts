import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { readFileSync, writeFileSync, existsSync } from "fs";
import { changelogCommand } from "../changelog";

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);

const CONFIG_CONTENT = `export SKYNET_PROJECT_NAME="test-project"
export SKYNET_PROJECT_DIR="/tmp/test"
export SKYNET_DEV_DIR="/tmp/test/.dev"
`;

const SAMPLE_COMPLETED = `# Completed Tasks

| Date | Task | Worker |
| --- | --- | --- |
| 2026-02-20 | [FEAT] Add user authentication — JWT-based login flow | w1 |
| 2026-02-20 | [FIX] Fix header overflow on mobile — CSS clamp issue | w2 |
| 2026-02-20 | [INFRA] Upgrade Node to v22 — LTS alignment | w3 |
| 2026-02-19 | [FEAT] Add dark mode toggle — theme context provider | w1 |
| 2026-02-19 | [TEST] Add unit tests for auth module — vitest coverage | w2 |
| 2026-02-19 | [DOCS] Update API reference — new endpoints documented | w3 |
| 2026-02-18 | [FIX] Fix race condition in worker lock — mkdir mutex | w1 |
`;

describe("changelogCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("completed.md")) return SAMPLE_COMPLETED as never;
      return "" as never;
    });
  });

  it("groups entries by date with ## YYYY-MM-DD headers", async () => {
    await changelogCommand({ dir: "/tmp/test" });

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");

    expect(output).toContain("## 2026-02-20");
    expect(output).toContain("## 2026-02-19");
    expect(output).toContain("## 2026-02-18");

    // Newest date should appear first
    const idx20 = output.indexOf("## 2026-02-20");
    const idx19 = output.indexOf("## 2026-02-19");
    const idx18 = output.indexOf("## 2026-02-18");
    expect(idx20).toBeLessThan(idx19);
    expect(idx19).toBeLessThan(idx18);
  });

  it("organizes tasks under correct tag headings", async () => {
    await changelogCommand({ dir: "/tmp/test" });

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");

    expect(output).toContain("### Features");
    expect(output).toContain("### Bug Fixes");
    expect(output).toContain("### Infrastructure");
    expect(output).toContain("### Tests");
    expect(output).toContain("### Documentation");

    // Verify specific entries appear under the right section
    // "Add user authentication" should be under Features, not Bug Fixes
    const featuresIdx = output.indexOf("### Features");
    const bugFixesIdx = output.indexOf("### Bug Fixes");
    const authIdx = output.indexOf("Add user authentication");
    expect(authIdx).toBeGreaterThan(featuresIdx);
    expect(authIdx).toBeLessThan(bugFixesIdx);
  });

  it("--since flag filters entries after given date", async () => {
    await changelogCommand({ dir: "/tmp/test", since: "2026-02-20" });

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");

    expect(output).toContain("## 2026-02-20");
    expect(output).not.toContain("## 2026-02-19");
    expect(output).not.toContain("## 2026-02-18");
  });

  it("--since flag shows message when no entries match", async () => {
    await changelogCommand({ dir: "/tmp/test", since: "2026-03-01" });

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");

    expect(output).toContain("No completed tasks found since 2026-03-01");
  });

  it("--output flag writes to file path instead of stdout", async () => {
    await changelogCommand({ dir: "/tmp/test", output: "/tmp/CHANGELOG.md" });

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = mockWriteFileSync.mock.calls[0];
    expect(writtenPath).toContain("CHANGELOG.md");
    expect(writtenContent as string).toContain("## 2026-02-20");
    expect(writtenContent as string).toContain("### Features");

    // Should log confirmation, not the changelog itself
    const logOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(logOutput).toContain("Changelog written to");
    expect(logOutput).toContain("Entries:");
  });

  it("handles empty completed.md gracefully", async () => {
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return CONFIG_CONTENT as never;
      if (path.endsWith("completed.md"))
        return "# Completed Tasks\n\n| Date | Task | Worker |\n| --- | --- | --- |\n" as never;
      return "" as never;
    });

    await changelogCommand({ dir: "/tmp/test" });

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");
    expect(output).toContain("No completed tasks found");
  });

  it("strips pipe delimiters and extra whitespace from task descriptions", async () => {
    await changelogCommand({ dir: "/tmp/test" });

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join("\n");

    // Should not contain raw pipe characters from the table format
    const lines = output.split("\n").filter((l) => l.startsWith("- "));
    for (const line of lines) {
      expect(line).not.toContain("|");
      // Should not have leading/trailing whitespace in the description
      const desc = line.slice(2); // remove "- " prefix
      expect(desc).toBe(desc.trim());
    }

    // Descriptions should have the em-dash portion truncated
    expect(output).toContain("- Add user authentication");
    expect(output).not.toContain("JWT-based login flow");
  });

  it("exits when completed.md does not exist", async () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("skynet.config.sh")) return true as never;
      if (path.endsWith("completed.md")) return false as never;
      return false as never;
    });

    await expect(changelogCommand({ dir: "/tmp/test" })).rejects.toThrow("process.exit");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("No completed.md found"),
    );
  });
});
