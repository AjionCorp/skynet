import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync } from "fs";
import type { SkynetConfig } from "../types";
import { parseBody } from "../lib/parse-body";
import { getSkynetDB } from "../lib/db";
import { parseBacklog as parseBacklogItems, backlogCounts, extractTitle } from "../lib/backlog-parser";

/**
 * Parse backlog.md into items with status/tag/dependency info.
 * Delegates to the canonical parseBacklog in backlog-parser.ts and adapts the shape.
 */
function parseBacklog(raw: string) {
  const parsed = parseBacklogItems(raw);
  const counts = backlogCounts(parsed);

  // Resolve blocked status (blocked if any dependency is not done)
  const titleToStatus = new Map<string, string>();
  for (const item of parsed) {
    titleToStatus.set(item.title, item.status);
  }

  const items = parsed.map((item) => ({
    text: item.raw,
    tag: item.tag ?? "",
    status: item.status,
    blockedBy: item.blockedBy,
    blocked: item.blockedBy.length > 0 &&
      item.blockedBy.some((dep) => titleToStatus.get(dep) !== "done"),
  }));

  return { items, ...counts };
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
      // Prefer SQLite, fallback to file
      try {
        const db = getSkynetDB(devDir);
        db.countPending(); // verify DB is initialized
        const backlog = db.getBacklogItems();
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
      } catch (sqliteErr) {
        console.warn(`[tasks GET] SQLite fallback: ${sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr)}`);
      }

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

        // Write to SQLite first (authoritative source)
        const db = getSkynetDB(devDir);
        db.addTask(title.trim(), tag, description?.trim() ?? "", position ?? "top", blockedBy?.trim() ?? "");

        // Regenerate backlog.md from SQLite
        try {
          db.exportBacklog(backlogPath);
        } catch (exportErr) {
          console.warn(`[tasks POST] backlog export failed, falling back to direct write: ${exportErr instanceof Error ? exportErr.message : String(exportErr)}`);
          // Fallback: write the single line directly
          const raw = readFileSync(backlogPath, "utf-8");
          const lines = raw.split("\n");
          if (position === "bottom") {
            let lastPendingIndex = -1;
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].startsWith("- [ ] ") || lines[i].startsWith("- [>] ")) {
                lastPendingIndex = i;
              }
            }
            if (lastPendingIndex === -1) {
              const headerEnd = lines.findIndex((l, i) => i > 0 && l.trim() === "");
              lines.splice(headerEnd + 1, 0, taskLine);
            } else {
              lines.splice(lastPendingIndex + 1, 0, taskLine);
            }
          } else {
            const firstTaskIndex = lines.findIndex(
              (l) => l.startsWith("- [ ] ") || l.startsWith("- [>] ")
            );
            if (firstTaskIndex === -1) {
              const headerEnd = lines.findIndex((l, i) => i > 0 && l.trim() === "");
              lines.splice(headerEnd + 1, 0, taskLine);
            } else {
              lines.splice(firstTaskIndex, 0, taskLine);
            }
          }
          const tmpPath = backlogPath + ".tmp";
          writeFileSync(tmpPath, lines.join("\n"), "utf-8");
          renameSync(tmpPath, backlogPath);
        }

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
