import { readFileSync, writeFileSync, mkdirSync, rmdirSync } from "fs";
import type { SkynetConfig } from "../types";

/**
 * Parse backlog.md into items with status/tag info.
 */
function parseBacklog(raw: string) {
  const lines = raw.split("\n");
  const items: { text: string; tag: string; status: "pending" | "claimed" | "done" }[] = [];
  let pendingCount = 0;
  let claimedCount = 0;
  let doneCount = 0;

  for (const line of lines) {
    if (line.startsWith("- [ ] ")) {
      const text = line.replace("- [ ] ", "");
      const tagMatch = text.match(/^\[([^\]]+)\]/);
      items.push({ text, tag: tagMatch?.[1] ?? "", status: "pending" });
      pendingCount++;
    } else if (line.startsWith("- [>] ")) {
      const text = line.replace("- [>] ", "");
      const tagMatch = text.match(/^\[([^\]]+)\]/);
      items.push({ text, tag: tagMatch?.[1] ?? "", status: "claimed" });
      claimedCount++;
    } else if (line.startsWith("- [x] ")) {
      const text = line.replace("- [x] ", "");
      const tagMatch = text.match(/^\[([^\]]+)\]/);
      items.push({ text, tag: tagMatch?.[1] ?? "", status: "done" });
      doneCount++;
    }
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
  const backlogLockPath = `${lockPrefix}backlog.lock`;

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
      const body = await request.json();
      const { tag, title, description, position } = body as {
        tag: string;
        title: string;
        description?: string;
        position?: "top" | "bottom";
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

      // Atomic lock acquisition using mkdir (same pattern as shell scripts)
      try {
        mkdirSync(backlogLockPath);
      } catch {
        return Response.json(
          { data: null, error: "Backlog is locked by another process" },
          { status: 423 }
        );
      }

      try {
        const desc = description?.trim()
          ? ` — ${description.trim()}`
          : "";
        const taskLine = `- [ ] [${tag}] ${title.trim()}${desc}`;

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

        writeFileSync(backlogPath, lines.join("\n"), "utf-8");

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
