import type { SkynetConfig } from "../types";
import type { FSWatcher } from "fs";
import { createPipelineStatusHandler } from "./pipeline-status";

let activeConnections = 0;
const MAX_SSE_CONNECTIONS = 20;

/** Reset active connection counter (for testing only). */
export function _resetActiveConnections(): void {
  activeConnections = 0;
}

/**
 * Create a GET handler for the pipeline/stream SSE endpoint.
 * Watches .dev/ files for changes using fs.watch and streams status updates.
 */
export function createPipelineStreamHandler(config: SkynetConfig) {
  const getStatus = createPipelineStatusHandler(config);

  return async function GET(): Promise<Response> {
    if (activeConnections >= MAX_SSE_CONNECTIONS) {
      return new Response("Too many SSE connections", { status: 503 });
    }
    activeConnections++;
    const { devDir } = config;
    const { watch } = await import("fs");

    let watcher: FSWatcher | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lifetimeTimeout: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let lastPayloadHash = "";

    function cleanup() {
      if (closed) return;
      closed = true;
      activeConnections = Math.max(0, activeConnections - 1);
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (lifetimeTimeout) {
        clearTimeout(lifetimeTimeout);
        lifetimeTimeout = null;
      }
    }

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        function send(text: string) {
          if (closed) return;
          // Backpressure: log when the client is consuming slower than we
          // produce (desiredSize <= 0 means the internal queue is full).
          // We still enqueue — ReadableStream handles natural backpressure
          // via its internal buffer — but log a warning for observability.
          if ((controller.desiredSize ?? 1) <= 0) {
            console.debug("[pipeline-stream] SSE backpressure: client is slow, event queued despite full buffer");
          }
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // Stream closed by client — clean up
            cleanup();
          }
        }

        function sendEvent(data: unknown) {
          send(`data: ${JSON.stringify(data)}\n\n`);
        }

        async function pushStatus() {
          try {
            const response = await getStatus();
            const json = await response.json();
            // Deduplicate: only push when data has changed from the last push.
            // Uses JSON.stringify as a simple hash — acceptable for the small
            // status payload (~2-5 KB). Avoids sending redundant SSE events
            // during idle periods when nothing has changed.
            const payload = JSON.stringify(json);
            if (payload === lastPayloadHash) return;
            lastPayloadHash = payload;
            sendEvent(json);
          } catch (err) {
            sendEvent({
              data: null,
              error:
                process.env.NODE_ENV === "development" && err instanceof Error
                  ? err.message
                  : "Failed to read status",
            });
          }
        }

        // Tell EventSource clients to retry after 5 seconds on disconnect
        send("retry: 5000\n\n");

        // Send initial status immediately
        await pushStatus();

        // Watch .dev/ directory for .md file changes
        try {
          watcher = watch(devDir, (_event, filename) => {
            if (!filename?.endsWith(".md") && !filename?.endsWith(".db-wal")) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => { pushStatus().catch(() => cleanup()); }, 500);
          });

          watcher.on("error", () => {
            cleanup();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
        } catch {
          // fs.watch not available or failed to initialize —
          // watcher remains null, polling interval below will still function.
          // Do NOT call cleanup() here — it would set closed=true and prevent polling.
          watcher = null;
        }

        // Poll every 10s to catch lock file changes (worker start/stop)
        // Lock files live in /tmp/ which fs.watch doesn't cover
        if (!closed) {
          heartbeatInterval = setInterval(() => {
            if (closed) {
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              return;
            }
            pushStatus().catch(() => {
              cleanup();
            });
          }, 10_000);
        }

        // Close stream after 5 minutes to prevent indefinite connections.
        // Clients using EventSource will automatically reconnect.
        if (!closed) {
          const MAX_LIFETIME_MS = 5 * 60 * 1000;
          lifetimeTimeout = setTimeout(() => {
            // Notify clients that the stream is closing due to session lifetime expiry
            send("event: auth-expired\ndata: {\"reason\":\"session-lifetime\"}\n\n");
            cleanup();
            try { controller.close(); } catch { /* already closed */ }
          }, MAX_LIFETIME_MS);
        }
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  };
}
