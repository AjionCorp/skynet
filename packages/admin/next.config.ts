import type { NextConfig } from "next";

// NOTE: CSP headers should be configured here via the `headers()` async function
// for production deployments. Currently omitted since the dashboard is intended
// for local/private network use behind SKYNET_DASHBOARD_API_KEY auth.

// NOTE: In production, configure binding address via environment:
//   HOST=127.0.0.1 pnpm dev:admin
// or use a reverse proxy (nginx, Caddy) on 127.0.0.1 and configure CORS/CSP there.
// The default Next.js behavior binds to 0.0.0.0 which is suitable for development
// but not production — it exposes the dashboard on all network interfaces.
const nextConfig: NextConfig = {
  transpilePackages: ["@ajioncorp/skynet"],
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
