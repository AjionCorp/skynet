import { resolve } from "path";
import { createConfig } from "@ajioncorp/skynet";

// Resolve .dev/ relative to the repo root (2 levels up from packages/admin)
const repoRoot = process.env.SKYNET_PROJECT_DIR || resolve(process.cwd(), "../..");
const devDir = process.env.SKYNET_DEV_DIR || resolve(repoRoot, ".dev");

const maxFixersEnv = Number(process.env.SKYNET_MAX_FIXERS);

export const config = createConfig({
  projectName: "skynet",
  devDir,
  lockPrefix: "/tmp/skynet-skynet",
  scriptsDir: resolve(repoRoot, "scripts"),
  maxFixers: Number.isFinite(maxFixersEnv) && maxFixersEnv > 0 ? maxFixersEnv : undefined,
});
