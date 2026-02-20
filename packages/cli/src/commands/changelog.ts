import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { loadConfig } from "../utils/loadConfig";

interface ChangelogOptions {
  dir?: string;
  output?: string;
  since?: string;
}

const TAG_SECTIONS: Record<string, string> = {
  "[FEAT]": "Features",
  "[FIX]": "Bug Fixes",
  "[INFRA]": "Infrastructure",
  "[TEST]": "Tests",
  "[DOCS]": "Documentation",
};

interface CompletedEntry {
  date: string;
  tag: string;
  description: string;
}

function parseCompletedEntries(content: string): CompletedEntry[] {
  const entries: CompletedEntry[] = [];

  const rows = content
    .split("\n")
    .filter((l) => l.startsWith("|") && !l.includes("| Date |") && !l.includes("---"));

  for (const row of rows) {
    const cols = row.split("|").map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;

    const date = cols[0];
    const task = cols[1];

    // Extract tag and description
    let tag = "";
    let description = task;

    for (const knownTag of Object.keys(TAG_SECTIONS)) {
      if (task.startsWith(knownTag)) {
        tag = knownTag;
        // Remove tag prefix and trim the description
        description = task.slice(knownTag.length).trim();
        // Remove leading dash/em-dash if present
        description = description.replace(/^[—–-]\s*/, "");
        break;
      }
    }

    // Truncate at the first em-dash to keep just the title portion
    const dashIdx = description.indexOf(" — ");
    if (dashIdx !== -1) {
      description = description.slice(0, dashIdx);
    }

    entries.push({ date, tag, description });
  }

  return entries;
}

function generateChangelog(entries: CompletedEntry[]): string {
  // Group by date
  const byDate = new Map<string, CompletedEntry[]>();

  for (const entry of entries) {
    const existing = byDate.get(entry.date);
    if (existing) {
      existing.push(entry);
    } else {
      byDate.set(entry.date, [entry]);
    }
  }

  // Sort dates descending (newest first)
  const sortedDates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));

  const lines: string[] = [];

  for (const date of sortedDates) {
    lines.push(`## ${date}`);

    const dateEntries = byDate.get(date)!;

    // Group by tag within this date
    const byTag = new Map<string, string[]>();

    for (const entry of dateEntries) {
      const sectionKey = entry.tag || "Other";
      const existing = byTag.get(sectionKey);
      if (existing) {
        existing.push(entry.description);
      } else {
        byTag.set(sectionKey, [entry.description]);
      }
    }

    // Output sections in a defined order
    const tagOrder = Object.keys(TAG_SECTIONS);

    for (const tag of tagOrder) {
      const descriptions = byTag.get(tag);
      if (!descriptions) continue;

      const sectionName = TAG_SECTIONS[tag];
      lines.push(`### ${sectionName}`);
      for (const desc of descriptions) {
        lines.push(`- ${desc}`);
      }
    }

    // Output any untagged entries
    const otherDescriptions = byTag.get("Other");
    if (otherDescriptions) {
      lines.push(`### Other`);
      for (const desc of otherDescriptions) {
        lines.push(`- ${desc}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

export async function changelogCommand(options: ChangelogOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const vars = loadConfig(projectDir);
  if (!vars) {
    console.error("skynet.config.sh not found. Run 'skynet init' first.");
    process.exit(1);
  }
  const devDir = vars.SKYNET_DEV_DIR || `${projectDir}/.dev`;

  const completedPath = join(devDir, "completed.md");
  if (!existsSync(completedPath)) {
    console.error("  No completed.md found. No tasks have been completed yet.");
    process.exit(1);
  }

  const content = readFileSync(completedPath, "utf-8");
  let entries = parseCompletedEntries(content);

  // Also read archived completions for full historical data
  const archivePath = join(devDir, "completed-archive.md");
  if (existsSync(archivePath)) {
    const archiveContent = readFileSync(archivePath, "utf-8");
    entries = entries.concat(parseCompletedEntries(archiveContent));
  }

  if (entries.length === 0) {
    console.log("  No completed tasks found.");
    return;
  }

  // Apply --since filter
  if (options.since) {
    entries = entries.filter((e) => e.date >= options.since!);
    if (entries.length === 0) {
      console.log(`  No completed tasks found since ${options.since}.`);
      return;
    }
  }

  const changelog = generateChangelog(entries);

  if (options.output) {
    const outputPath = resolve(options.output);
    writeFileSync(outputPath, changelog, "utf-8");
    console.log(`  Changelog written to: ${outputPath}`);
    console.log(`  Entries: ${entries.length}`);
  } else {
    console.log(changelog);
  }
}
