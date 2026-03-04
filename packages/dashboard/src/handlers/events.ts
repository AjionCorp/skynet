import { spawnSync } from "child_process";
import type { SkynetConfig, EventEntry } from "../types";
import { getSkynetDB } from "../lib/db";
import { logHandlerError } from "../lib/handler-error";

export function createEventsHandler(config: SkynetConfig) {
  const eventsPath = `${config.devDir}/events.log`;

  return async function GET(): Promise<Response> {
    try {
      // Prefer SQLite, fallback to file
      try {
        const db = getSkynetDB(config.devDir, { readonly: true });
        db.countPending(); // verify DB is initialized
        const entries = db.getRecentEvents(100);
        return Response.json({ data: entries, error: null });
      } catch (sqliteErr) {
        console.warn(`[events] SQLite fallback: ${sqliteErr instanceof Error ? sqliteErr.message : String(sqliteErr)}`);
      }

      // Read only the last 100 lines instead of the entire file to avoid
      // unbounded memory usage on large events.log files.
      const tailResult = spawnSync("tail", ["-100", eventsPath], {
        encoding: "utf-8",
        timeout: 5000,
      });
      if (tailResult.status !== 0 && tailResult.stderr) {
        console.warn(`[events] tail failed (rc=${tailResult.status}): ${tailResult.stderr.trim()}`);
      }
      const raw = tailResult.stdout || "";
      if (!raw.trim()) {
        return Response.json({ data: [] as EventEntry[], error: null });
      }

      const lines = raw.trim().split("\n");
      const entries: EventEntry[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split("|");
        if (parts.length < 3) continue;

        const epoch = Number(parts[0]);
        if (!Number.isFinite(epoch)) continue;
        if (epoch < 0 || epoch > 4.1e9) continue;  // 4.1e9 ≈ 2099-11-20, reject future epochs

        const detail = parts.slice(2).join("|");
        const workerMatch = detail.match(/^(?:Worker|Fixer)\s+(\d+):/);
        const rawWorker = workerMatch ? Number(workerMatch[1]) : undefined;
        const worker = rawWorker !== undefined && rawWorker >= 0 && rawWorker <= 999 ? rawWorker : undefined;

        entries.push({
          ts: new Date(epoch * 1000).toISOString(),
          event: parts[1],
          worker,
          detail,
        });
      }

      return Response.json({ data: entries, error: null });
    } catch (err) {
      logHandlerError(config.devDir, "events", err);
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
  };
}
