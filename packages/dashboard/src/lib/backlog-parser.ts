/**
 * Extract the task title from raw text (strip tag prefix and description/metadata suffixes).
 */
export function extractTitle(text: string): string {
  const withoutMeta = text.replace(/\s*\|\s*blockedBy:\s*.+$/i, "");
  const withoutTag = withoutMeta.replace(/^\[[^\]]+\]\s*/, "");
  const dashIdx = withoutTag.indexOf(" \u2014 ");
  const title = (dashIdx >= 0 ? withoutTag.slice(0, dashIdx) : withoutTag).trim();
  return title.slice(0, 60);
}

/**
 * Parse blockedBy metadata from raw text.
 */
export function parseBlockedBy(text: string): string[] {
  const match = text.match(/\s*\|\s*blockedBy:\s*(.+)$/i);
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
}

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
 * NOTE: This is a second pass over already-parsed items (O(n) on the item count,
 * not on the raw file). Acceptable at expected backlog scale (<100 items).
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

export interface BacklogItemWithBlocked {
  text: string;
  tag: string;
  status: "pending" | "claimed" | "done";
  blockedBy: string[];
  blocked: boolean;
}

/**
 * Parse backlog.md into items with resolved blocked status and counts.
 * This is the canonical "parse + resolve dependencies" wrapper used by handlers.
 *
 * Includes cycle detection: if resolving blockedBy for a task leads back to
 * itself (e.g. A blocks B blocks A), the task is marked as blocked to prevent
 * infinite resolution loops. Cycles are detected via a visited-set approach
 * during transitive dependency resolution.
 */
export function parseBacklogWithBlocked(raw: string): {
  items: BacklogItemWithBlocked[];
  pendingCount: number;
  claimedCount: number;
  doneCount: number;
} {
  const parsed = parseBacklog(raw);
  const counts = backlogCounts(parsed);

  // Build lookup maps for dependency resolution
  const titleToStatus = new Map<string, string>();
  const titleToBlockedBy = new Map<string, string[]>();
  for (const item of parsed) {
    titleToStatus.set(item.title, item.status);
    titleToBlockedBy.set(item.title, item.blockedBy);
  }

  // Detect whether a task is blocked, including transitive dependency cycles.
  // Uses a visited set to break cycles: if we encounter a task already being
  // resolved, that means we have a circular dependency (A -> B -> A), so the
  // task is blocked. This IS live code — called from the items.map() below
  // to resolve blocked status for each backlog item.
  function isBlocked(title: string, visiting: Set<string>): boolean {
    const deps = titleToBlockedBy.get(title);
    if (!deps || deps.length === 0) return false;

    visiting.add(title);

    for (const dep of deps) {
      // Cycle detected — dependency leads back to a task we're already resolving
      if (visiting.has(dep)) return true;

      const depStatus = titleToStatus.get(dep);
      // Dependency not done and not in the backlog (external/unknown) — blocked
      if (depStatus === undefined) return true;
      // Dependency is done — this path is clear
      if (depStatus === "done") continue;
      // Dependency is not done — recurse to check transitive cycles
      // (e.g. A -> B -> C -> A should mark all three as blocked)
      if (isBlocked(dep, visiting)) return true;
      // Dep is not done and has no transitive cycle — still blocked
      return true;
    }

    visiting.delete(title);
    return false;
  }

  const items: BacklogItemWithBlocked[] = parsed.map((item) => ({
    text: item.raw,
    tag: item.tag ?? "",
    status: item.status,
    blockedBy: item.blockedBy,
    blocked:
      item.blockedBy.length > 0 && isBlocked(item.title, new Set<string>()),
  }));

  return { items, ...counts };
}
