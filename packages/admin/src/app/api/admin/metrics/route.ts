// Auth: Protected by middleware.ts — all /api/* routes require SKYNET_DASHBOARD_API_KEY.
//
// Prometheus scraping: This endpoint is behind cookie-based auth, which is not
// compatible with standard Prometheus scrape configs. To scrape metrics:
//   Option A — Use Bearer token auth by setting the raw API key as a Bearer token
//     in the Prometheus scrape config:
//       authorization:
//         type: Bearer
//         credentials: <SKYNET_DASHBOARD_API_KEY>
//     The middleware accepts both cookie-based sessions and Authorization headers.
//   Option B — For network-isolated deployments (e.g., behind a VPN or on localhost),
//     add this route to the middleware bypass list so it can be scraped without auth.
//     Only do this if the endpoint is not exposed to the public internet.
import { createMetricsHandler } from "@ajioncorp/skynet/handlers";
import { config } from "@/lib/skynet-config";

export const GET = createMetricsHandler(config);
export const dynamic = "force-dynamic";
