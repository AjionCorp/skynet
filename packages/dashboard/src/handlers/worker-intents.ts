import type { SkynetConfig, WorkerIntent } from "../types";
import { getSkynetDB } from "../lib/db";
import { logHandlerError } from "../lib/handler-error";

/**
 * Create a GET handler for the workers/intents endpoint.
 * Returns each worker's current intent: status, task, heartbeat, and progress info.
 */
export function createWorkerIntentsHandler(config: SkynetConfig) {
  const { devDir } = config;

  async function GET(): Promise<Response> {
    try {
      const db = getSkynetDB(devDir, { readonly: true });
      const rows = db.getWorkerIntents();
      const now = Date.now();

      const intents: WorkerIntent[] = rows.map((row) => ({
        workerId: row.workerId,
        workerType: row.workerType,
        status: row.status,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        branch: row.branch,
        startedAt: row.startedAt,
        lastHeartbeat: row.heartbeatEpoch,
        heartbeatAgeMs: row.heartbeatEpoch ? now - row.heartbeatEpoch * 1000 : null,
        lastProgress: row.progressEpoch,
        progressAgeMs: row.progressEpoch ? now - row.progressEpoch * 1000 : null,
        lastInfo: row.lastInfo,
        updatedAt: row.updatedAt,
      }));

      return Response.json({ data: { intents }, error: null });
    } catch (err) {
      logHandlerError(devDir, "worker-intents:GET", err);
      return Response.json(
        {
          data: null,
          error:
            process.env.NODE_ENV === "development" && err instanceof Error
              ? err.message
              : "Failed to retrieve worker intents",
        },
        { status: 500 },
      );
    }
  }

  return { GET };
}
