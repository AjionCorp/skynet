import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getLocalVersion(): string {
  // From dist/commands/ -> package root
  const pkgPath = resolve(__dirname, "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version;
}

function getLatestVersion(): string | null {
  try {
    const result = execSync("npm view @ajioncorp/skynet-cli version", {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

export async function versionCommand(): Promise<void> {
  const localVersion = getLocalVersion();
  console.log(`skynet-cli v${localVersion}`);

  const latest = getLatestVersion();
  if (latest && latest !== localVersion) {
    console.log();
    console.log(`  Update available: v${localVersion} → v${latest}`);
    console.log(`  Run: npm install -g @ajioncorp/skynet-cli@latest`);
  }
}
