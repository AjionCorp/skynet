import type { SkynetConfig } from "../types";
import type { FSWatcher } from "fs";
import { createPipelineStatusHandler } from "./pipeline-status";

/**
 * Create a GET handler for the pipeline/stream SSE endpoint.
 * Watches .dev/ files for changes using fs.watch and streams status updates.
 */
export function createPipelineStreamHandler(config: SkynetConfig) {
  const getStatus = createPipelineStatusHandler(config);

  return async function GET(): Promise<Response> {
    const { devDir } = config;
    const { watch } = await import("fs");

    let watcher: FSWatcher | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function cleanup() {
      closed = true;
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
    }

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        function send(text: string) {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
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
            sendEvent(json);
          } catch (err) {
            sendEvent({
              data: null,
              error:
                err instanceof Error
                  ? err.message
                  : "Failed to read status",
            });
          }
        }

        // Send initial status immediately
        await pushStatus();

        // Watch .dev/ directory for .md file changes
        try {
          watcher = watch(devDir, (_event, filename) => {
            if (!filename?.endsWith(".md")) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => pushStatus(), 500);
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
          // fs.watch not available — client will rely on EventSource reconnect
        }

        // Heartbeat every 30s to keep the connection alive through proxies
        heartbeatInterval = setInterval(() => {
          send(": heartbeat\n\n");
        }, 30_000);
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };
}
