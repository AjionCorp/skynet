import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configMigrateCommand } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface UpgradeOptions {
  check?: boolean;
}

function getLocalVersion(): string {
  const pkgPath = resolve(__dirname, "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version;
}

function getLatestVersion(): string | null {
  try {
    const result = execSync("npm view @ajioncorp/skynet-cli version", {
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

export async function upgradeCommand(options: UpgradeOptions): Promise<void> {
  const localVersion = getLocalVersion();

  console.log(`  Current version: v${localVersion}`);
  console.log(`  Checking npm registry...`);

  const latest = getLatestVersion();

  if (!latest) {
    console.error(`\n  Failed to check npm registry. Are you online?`);
    process.exitCode = 1;
    return;
  }

  if (latest === localVersion) {
    console.log(`\n  Already on latest version (${localVersion}).`);
    return;
  }

  console.log(`\n  Update available: v${localVersion} → v${latest}`);

  if (options.check) {
    console.log(`\n  Run 'skynet upgrade' to install.`);
    return;
  }

  console.log(`  Installing @ajioncorp/skynet-cli@latest...`);

  try {
    execSync("npm install -g @ajioncorp/skynet-cli@latest", {
      timeout: 60000,
      stdio: "inherit",
    });
    console.log(`\n  Upgraded to v${latest}.`);
  } catch {
    console.error(`\n  Upgrade failed. Try manually: npm install -g @ajioncorp/skynet-cli@latest`);
    process.exitCode = 1;
    return;
  }

  // Auto-migrate config if a .dev/skynet.config.sh exists in cwd
  const projectDir = process.cwd();
  if (existsSync(join(projectDir, ".dev/skynet.config.sh"))) {
    console.log(`\n  Migrating config...`);
    try {
      await configMigrateCommand({ dir: projectDir });
    } catch {
      console.error(`  Config migration failed — run 'skynet config migrate' manually.`);
    }
  }
}
