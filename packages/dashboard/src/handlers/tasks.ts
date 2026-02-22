import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync } from "fs";
import type { SkynetConfig } from "../types";
import { parseBody } from "../lib/parse-body";

/**
 * Extract the task title from raw text (strip tag prefix and description/metadata suffixes).
 */
function extractTitle(text: string): string {
  // Remove blockedBy metadata suffix
  const withoutMeta = text.replace(/\s*\|\s*blockedBy:\s*.+$/i, "");
  // Remove tag prefix
  const withoutTag = withoutMeta.replace(/^\[[^\]]+\]\s*/, "");
  // Remove description after em-dash
  const dashIdx = withoutTag.indexOf(" \u2014 ");
  return (dashIdx >= 0 ? withoutTag.slice(0, dashIdx) : withoutTag).trim();
}

/**
 * Parse blockedBy metadata from raw text.
 */
function parseBlockedBy(text: string): string[] {
  const match = text.match(/\s*\|\s*blockedBy:\s*(.+)$/i);
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse backlog.md into items with status/tag/dependency info.
 */
function parseBacklog(raw: string) {
  const lines = raw.split("\n");
  const items: { text: string; tag: string; status: "pending" | "claimed" | "done"; blockedBy: string[]; blocked: boolean }[] = [];
  let pendingCount = 0;
  let claimedCount = 0;
  let doneCount = 0;

  // First pass: collect all items
  const rawItems: { text: string; tag: string; status: "pending" | "claimed" | "done"; blockedBy: string[] }[] = [];
  for (const line of lines) {
    let status: "pending" | "claimed" | "done" | null = null;
    let text = "";
    if (line.startsWith("- [ ] ")) {
      status = "pending";
      text = line.replace("- [ ] ", "");
      pendingCount++;
    } else if (line.startsWith("- [>] ")) {
      status = "claimed";
      text = line.replace("- [>] ", "");
      claimedCount++;
    } else if (line.startsWith("- [x] ")) {
      status = "done";
      text = line.replace("- [x] ", "");
      doneCount++;
    }
    if (status === null) continue;

    const tagMatch = text.match(/^\[([^\]]+)\]/);
    const blockedBy = parseBlockedBy(text);
    rawItems.push({ text, tag: tagMatch?.[1] ?? "", status, blockedBy });
  }

  // Second pass: resolve blocked status (blocked if any dependency is not done)
  const titleToStatus = new Map<string, string>();
  for (const item of rawItems) {
    titleToStatus.set(extractTitle(item.text), item.status);
  }

  for (const item of rawItems) {
    const blocked = item.blockedBy.length > 0 &&
      item.blockedBy.some((dep) => titleToStatus.get(dep) !== "done");
    items.push({ ...item, blocked });
  }

  return { items, pendingCount, claimedCount, doneCount };
}

/**
 * Create GET and POST handlers for the tasks endpoint.
 *
 * GET: Returns current backlog items (excluding done).
 * POST: Adds a new task to the backlog.
 */
export function createTasksHandlers(config: SkynetConfig) {
  const { devDir, lockPrefix, taskTags } = config;
  const backlogPath = `${devDir}/backlog.md`;
  const backlogLockPath = `${lockPrefix}-backlog.lock`;

  async function GET(): Promise<Response> {
    try {
      const raw = readFileSync(backlogPath, "utf-8");
      const backlog = parseBacklog(raw);
      const items = backlog.items.filter((i) => i.status !== "done");
      return Response.json({
        data: {
          items,
          pendingCount: backlog.pendingCount,
          claimedCount: backlog.claimedCount,
          doneCount: backlog.doneCount,
        },
        error: null,
      });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to read backlog",
        },
        { status: 500 }
      );
    }
  }

  async function POST(request: Request): Promise<Response> {
    try {
      const { data: body, error: parseError, status: parseStatus } = await parseBody<{
        tag: string;
        title: string;
        description?: string;
        position?: "top" | "bottom";
        blockedBy?: string;
      }>(request);
      if (parseError || !body) {
        return Response.json({ data: null, error: parseError }, { status: parseStatus ?? 400 });
      }
      const { tag, title, description, position, blockedBy } = body as {
        tag: string;
        title: string;
        description?: string;
        position?: "top" | "bottom";
        blockedBy?: string;
      };

      if (!tag || !taskTags.includes(tag)) {
        return Response.json(
          {
            data: null,
            error: `Invalid tag. Must be one of: ${taskTags.join(", ")}`,
          },
          { status: 400 }
        );
      }
      if (!title || title.trim().length === 0) {
        return Response.json(
          { data: null, error: "Title is required" },
          { status: 400 }
        );
      }
      if (title.length > 500) {
        return Response.json(
          { data: null, error: "Title must be 500 characters or fewer" },
          { status: 400 }
        );
      }
      if (description && description.length > 2000) {
        return Response.json(
          { data: null, error: "Description must be 2000 characters or fewer" },
          { status: 400 }
        );
      }
      // Reject newlines to prevent markdown injection into backlog
      if (/[\n\r]/.test(title) || (description && /[\n\r]/.test(description)) || (blockedBy && /[\n\r]/.test(blockedBy))) {
        return Response.json(
          { data: null, error: "Fields must not contain newlines" },
          { status: 400 }
        );
      }

      // Atomic lock acquisition using mkdir with retry (mirrors shell script pattern)
      let lockAcquired = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          mkdirSync(backlogLockPath);
          lockAcquired = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!lockAcquired) {
        return Response.json(
          { data: null, error: "Backlog is locked by another process" },
          { status: 423 }
        );
      }

      try {
        const desc = description?.trim()
          ? ` \u2014 ${description.trim()}`
          : "";
        const blocked = blockedBy?.trim()
          ? ` | blockedBy: ${blockedBy.trim()}`
          : "";
        const taskLine = `- [ ] [${tag}] ${title.trim()}${desc}${blocked}`;

        const raw = readFileSync(backlogPath, "utf-8");
        const lines = raw.split("\n");

        if (position === "bottom") {
          let lastPendingIndex = -1;
          for (let i = 0; i < lines.length; i++) {
            if (
              lines[i].startsWith("- [ ] ") ||
              lines[i].startsWith("- [>] ")
            ) {
              lastPendingIndex = i;
            }
          }
          if (lastPendingIndex === -1) {
            const headerEnd = lines.findIndex(
              (l, i) => i > 0 && l.trim() === ""
            );
            lines.splice(headerEnd + 1, 0, taskLine);
          } else {
            lines.splice(lastPendingIndex + 1, 0, taskLine);
          }
        } else {
          const firstTaskIndex = lines.findIndex(
            (l) =>
              l.startsWith("- [ ] ") || l.startsWith("- [>] ")
          );
          if (firstTaskIndex === -1) {
            const headerEnd = lines.findIndex(
              (l, i) => i > 0 && l.trim() === ""
            );
            lines.splice(headerEnd + 1, 0, taskLine);
          } else {
            lines.splice(firstTaskIndex, 0, taskLine);
          }
        }

        const tmpPath = backlogPath + ".tmp";
        writeFileSync(tmpPath, lines.join("\n"), "utf-8");
        renameSync(tmpPath, backlogPath);

        return Response.json({
          data: { inserted: taskLine, position: position ?? "top" },
          error: null,
        });
      } finally {
        try { rmdirSync(backlogLockPath); } catch { /* ignore */ }
      }
    } catch (err) {
      return Response.json(
        {
          data: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to add task",
        },
        { status: 500 }
      );
    }
  }

  return { GET, POST };
}
