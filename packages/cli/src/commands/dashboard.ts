import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn, exec } from "child_process";
import { platform } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the monorepo root: when installed from npm the package root is two
// levels up from dist/commands/dashboard.js; during monorepo development the
// monorepo root is four levels up (same pattern as init.ts).
function resolveSkynetRoot(): string {
  // Package root (two levels up from dist/commands/)
  const pkgRoot = fileURLToPath(new URL("../../", import.meta.url));
  const monorepoFromPkg = resolve(pkgRoot, "../..");
  if (existsSync(resolve(monorepoFromPkg, "packages/admin"))) {
    return monorepoFromPkg;
  }
  // Fallback: four levels up from __dirname
  const fallback = resolve(__dirname, "../../../..");
  if (existsSync(resolve(fallback, "packages/admin"))) {
    return fallback;
  }
  return pkgRoot;
}

interface DashboardOptions {
  port?: string;
}

function openBrowser(url: string) {
  const cmd = platform() === "darwin" ? "open" : "xdg-open";
  exec(`${cmd} ${url}`, () => {
    // Silently ignore errors (e.g. no display available)
  });
}

export async function dashboardCommand(options: DashboardOptions) {
  const port = options.port || "3100";

  // Validate port
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    console.error("  Error: Port must be a number between 1 and 65535");
    process.exit(1);
  }

  const skynetRoot = resolveSkynetRoot();
  const adminPkgPath = resolve(skynetRoot, "packages/admin");

  if (!existsSync(adminPkgPath)) {
    console.error("  Error: Admin package not found at packages/admin.");
    console.error("  Make sure you are running from the skynet monorepo.");
    process.exit(1);
  }

  console.log(`\n  Starting Skynet dashboard on port ${portNum}...\n`);

  const child = spawn("pnpm", ["--filter", "admin", "dev", "--", "--port", String(portNum)], {
    cwd: skynetRoot,
    stdio: "inherit",
  });

  // Open browser after a short delay to let the dev server start
  setTimeout(() => {
    const url = `http://localhost:${portNum}`;
    console.log(`\n  Opening ${url} in browser...\n`);
    openBrowser(url);
  }, 3000);

  child.on("error", (err) => {
    console.error(`  Error starting dashboard: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
