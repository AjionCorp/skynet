import { readFileSync } from "fs";
import type { SkynetConfig, EventEntry } from "../types";

export function createEventsHandler(config: SkynetConfig) {
  const eventsPath = `${config.devDir}/events.log`;

  return async function GET(): Promise<Response> {
    try {
      let raw: string;
      try {
        raw = readFileSync(eventsPath, "utf-8");
      } catch {
        return Response.json({ data: [] as EventEntry[], error: null });
      }

      const lines = raw.trim().split("\n");
      const entries: EventEntry[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split("|");
        if (parts.length < 3) continue;

        const epoch = Number(parts[0]);
        if (Number.isNaN(epoch)) continue;

        const detail = parts.slice(2).join("|");
        const workerMatch = detail.match(/^(?:Worker|Fixer)\s+(\d+):/);
        const worker = workerMatch ? Number(workerMatch[1]) : undefined;

        entries.push({
          ts: new Date(epoch * 1000).toISOString(),
          event: parts[1],
          worker,
          detail,
        });
      }

      const last100 = entries.slice(-100);

      return Response.json({ data: last100, error: null });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error: err instanceof Error ? err.message : "Failed to read events",
        },
        { status: 500 }
      );
    }
  };
}
