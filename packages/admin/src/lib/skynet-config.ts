import { resolve } from "path";
import { createConfig } from "@ajioncorp/skynet";

// Resolve .dev/ relative to the repo root (2 levels up from packages/admin)
const repoRoot = process.env.SKYNET_PROJECT_DIR || resolve(process.cwd(), "../..");
const devDir = process.env.SKYNET_DEV_DIR || resolve(repoRoot, ".dev");

const maxFixersEnv = Number(process.env.SKYNET_MAX_FIXERS);
const projectName = process.env.SKYNET_PROJECT_NAME || "skynet";
const lockPrefix = process.env.SKYNET_LOCK_PREFIX || `/tmp/skynet-${projectName}`;

export const config = createConfig({
  projectName,
  devDir,
  lockPrefix,
  scriptsDir: resolve(repoRoot, "scripts"),
  maxFixers: Number.isFinite(maxFixersEnv) && maxFixersEnv > 0 ? maxFixersEnv : undefined,
});
