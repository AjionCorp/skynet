export interface ParsedBacklogItem {
  raw: string;
  status: "pending" | "claimed" | "done";
  tag: string | null;
  title: string;
  description: string | null;
  blockedBy: string[];
}

/**
 * Parse a backlog.md file into structured items.
 *
 * Expected format:
 *   - [ ] [TAG] Title text — optional description
 *   - [>] [TAG] Claimed task
 *   - [x] [TAG] Done task
 */
export function parseBacklog(content: string): ParsedBacklogItem[] {
  const lines = content.split("\n");
  const items: ParsedBacklogItem[] = [];

  for (const line of lines) {
    let status: "pending" | "claimed" | "done" | null = null;
    let text = "";

    if (line.startsWith("- [ ] ")) {
      status = "pending";
      text = line.replace("- [ ] ", "");
    } else if (line.startsWith("- [>] ")) {
      status = "claimed";
      text = line.replace("- [>] ", "");
    } else if (line.startsWith("- [x] ")) {
      status = "done";
      text = line.replace("- [x] ", "");
    }

    if (status === null) continue;

    // Extract blockedBy metadata from " | blockedBy: ..." suffix
    let blockedBy: string[] = [];
    const blockedByMatch = text.match(/\s*\|\s*blockedBy:\s*(.+)$/i);
    const textWithoutMeta = blockedByMatch
      ? text.slice(0, text.length - blockedByMatch[0].length)
      : text;
    if (blockedByMatch) {
      blockedBy = blockedByMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const tagMatch = textWithoutMeta.match(/^\[([^\]]+)\]\s*/);
    const tag = tagMatch?.[1] ?? null;
    const afterTag = tagMatch
      ? textWithoutMeta.slice(tagMatch[0].length)
      : textWithoutMeta;

    // Split on " — " for title/description separation
    const dashIndex = afterTag.indexOf(" — ");
    const title = dashIndex >= 0 ? afterTag.slice(0, dashIndex) : afterTag;
    const description =
      dashIndex >= 0 ? afterTag.slice(dashIndex + 3).trim() || null : null;

    items.push({
      raw: text,
      status,
      tag,
      title: title.trim(),
      description,
      blockedBy,
    });
  }

  return items;
}

/**
 * Summarize backlog counts from parsed items.
 */
export function backlogCounts(items: ParsedBacklogItem[]): {
  pendingCount: number;
  claimedCount: number;
  doneCount: number;
} {
  let pendingCount = 0;
  let claimedCount = 0;
  let doneCount = 0;
  for (const item of items) {
    if (item.status === "pending") pendingCount++;
    else if (item.status === "claimed") claimedCount++;
    else if (item.status === "done") doneCount++;
  }
  return { pendingCount, claimedCount, doneCount };
}
