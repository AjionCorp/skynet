import type { NextConfig } from "next";

// NOTE: CSP headers should be configured here via the `headers()` async function
// for production deployments. Currently omitted since the dashboard is intended
// for local/private network use behind SKYNET_DASHBOARD_API_KEY auth.

// NOTE: In production, bind the dev server to localhost only (--hostname 127.0.0.1)
// to prevent exposing the dashboard on all network interfaces. The default Next.js
// behavior binds to 0.0.0.0 which is suitable for development but not production.
const nextConfig: NextConfig = {
  transpilePackages: ["@ajioncorp/skynet"],
};

export default nextConfig;
