import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync, existsSync, rmSync } from "fs";
import { resolve } from "path";
import type { SkynetConfig } from "../types";
import { parseBody } from "../lib/parse-body";
import { getSkynetDB } from "../lib/db";
import { checkRateLimit } from "../lib/rate-limiter";
import { parseBacklogWithBlocked } from "../lib/backlog-parser";
import { logHandlerError } from "../lib/handler-error";

const MAX_DESCRIPTION_LENGTH = 2000;

// Rate limiting for POST requests: max 30 per 60 seconds.
// Uses in-memory sliding window — decoupled from SkynetDB so the database
// can be opened in readonly mode for read-only consumers (GET handlers).
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_KEY = "task_create";

function getActiveMissionSlug(devDir: string): string | null {
  try {
    const configPath = resolve(devDir, "missions", "_config.json");
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as { activeMission?: string };
    const slug = config.activeMission;
    if (!slug) return null;
    const missionPath = resolve(devDir, "missions", `${slug}.md`);
    if (!existsSync(missionPath)) return null;
    return slug;
  } catch {
    return null;
  }
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

  async function GET(request?: Request): Promise<Response> {
    try {
      // Extract optional mission slug from query params
      let requestedMission: string | null = null;
      if (request) {
        try {
          const url = new URL(request.url);
          requestedMission = url.searchParams.get("slug");
        } catch { /* ignore */ }
      }

      // Prefer SQLite, fallback to file
      try {
        const db = getSkynetDB(devDir, { readonly: true });
        db.countPending(); // verify DB is initialized
        const activeMission = getActiveMissionSlug(devDir);
        const missionHash = requestedMission || activeMission;
        const backlog = db.getBacklogItems(missionHash ?? "");
        const items = backlog.items.filter((i) => i.status !== "done");
        return Response.json({
          data: {
            items,
            pendingCount: backlog.pendingCount,
            claimedCount: backlog.claimedCount,
            manualDoneCount: backlog.manualDoneCount,
          },
          error: null,
        });
      } catch (sqliteErr) {
        console.warn(`[tasks GET] SQLite fallback: ${sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr)}`);
      }

      const raw = readFileSync(backlogPath, "utf-8");
      const backlog = parseBacklogWithBlocked(raw);
      const items = backlog.items.filter((i) => i.status !== "done");
      return Response.json({
        data: {
          items,
          pendingCount: backlog.pendingCount,
          claimedCount: backlog.claimedCount,
          manualDoneCount: backlog.manualDoneCount,
        },
        error: null,
      });
    } catch (err) {
      logHandlerError(devDir, "tasks:GET", err);
      return Response.json(
        {
          data: null,
          error: process.env.NODE_ENV === "development"
            ? (err instanceof Error ? err.message : "Internal error")
            : "Internal server error",
        },
        { status: 500 }
      );
    }
  }

  async function POST(request: Request): Promise<Response> {
    // Extract optional mission slug from query params
    let requestedMission: string | null = null;
    try {
      const url = new URL(request.url);
      requestedMission = url.searchParams.get("slug");
    } catch { /* ignore */ }

    // Rate limiting: in-memory sliding window (no DB writes needed).
    const rateLimitAllowed = checkRateLimit(RATE_LIMIT_KEY, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
    if (!rateLimitAllowed) {
      return Response.json(
        { data: null, error: "Rate limit exceeded. Max 30 tasks per minute." },
        { status: 429 }
      );
    }

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
      const normalizedPosition =
        position == null
          ? "top"
          : position === "top" || position === "bottom"
            ? position
            : null;

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
      if (description && description.length > MAX_DESCRIPTION_LENGTH) {
        return Response.json(
          { data: null, error: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` },
          { status: 400 }
        );
      }
      if (!normalizedPosition) {
        return Response.json(
          { data: null, error: "Invalid position. Must be 'top' or 'bottom'" },
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

      // Atomic lock acquisition using mkdir with PID tracking and stale detection
      let lockAcquired = false;
      const pidFile = `${backlogLockPath}/pid`;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          mkdirSync(backlogLockPath);
          try {
            writeFileSync(pidFile, String(process.pid), "utf-8");
          } catch {
            // PID write failed — release the lock to avoid orphan
            try { rmdirSync(backlogLockPath); } catch { /* ignore */ }
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
          lockAcquired = true;
          break;
        } catch {
          // mkdir failed — check for stale lock
          try {
            if (existsSync(pidFile)) {
              const holderPid = Number(readFileSync(pidFile, "utf-8").trim());
              if (Number.isFinite(holderPid) && holderPid > 0) {
                try {
                  process.kill(holderPid, 0); // check if process exists
                } catch {
                  // Holder is dead — break the stale lock
                  try {
                    rmSync(backlogLockPath, { recursive: true, force: true });
                  } catch { /* ignore — another process may have cleaned it up */ }
                  continue; // retry immediately
                }
              }
            } else if (existsSync(backlogLockPath)) {
              // Lock dir exists but no PID file — likely crashed between mkdir and PID write
              try {
                rmdirSync(backlogLockPath);
              } catch { /* ignore */ }
              continue; // retry immediately
            }
          } catch { /* ignore stale check errors */ }
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
        const activeMission = getActiveMissionSlug(devDir);
        const missionHash = requestedMission || activeMission;
        db.addTask(
          title.trim(),
          tag,
          description?.trim() ?? "",
          normalizedPosition,
          blockedBy?.trim() ?? "",
          missionHash ?? ""
        );

        // SQLite is authoritative — backlog.md is a best-effort regeneration for legacy compatibility.
        // If exportBacklog fails, the task is still safely in SQLite.
        try {
          db.exportBacklog(backlogPath);
        } catch (exportErr) {
          console.warn(`[tasks POST] backlog export failed, falling back to direct write: ${exportErr instanceof Error ? exportErr.message : String(exportErr)}`);
          // Fallback: write the single line directly
          try {
            const raw = readFileSync(backlogPath, "utf-8");
            const lines = raw.split("\n");
            if (normalizedPosition === "bottom") {
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
          } catch (fallbackErr) {
            console.error(`[tasks POST] CRITICAL: Both SQLite export and file fallback failed. Task exists in SQLite only. Export error: ${exportErr instanceof Error ? exportErr.message : String(exportErr)}. File error: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
            return Response.json({
              data: { inserted: taskLine, position: normalizedPosition, warning: "Task saved to SQLite but backlog.md sync failed. Run watchdog to reconcile." },
              error: null,
            });
          }
        }

        return Response.json({
          data: { inserted: taskLine, position: normalizedPosition },
          error: null,
        });
      } finally {
        try {
          rmSync(backlogLockPath, { recursive: true, force: true });
        } catch { /* lock cleanup failure is non-fatal — lock dir may already be removed by another process */ }
      }
    } catch (err) {
      logHandlerError(devDir, "tasks:POST", err);
      return Response.json(
        {
          data: null,
          error: process.env.NODE_ENV === "development"
            ? (err instanceof Error ? err.message : "Internal error")
            : "Internal server error",
        },
        { status: 500 }
      );
    }
  }

  return { GET, POST };
}
