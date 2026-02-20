import { resolve } from "path";
import { createConfig } from "@ajioncorp/skynet";

// Resolve .dev/ relative to the repo root (2 levels up from packages/admin)
const repoRoot = resolve(process.cwd(), "../..");
const devDir = resolve(repoRoot, ".dev");

const maxFixersEnv = Number(process.env.SKYNET_MAX_FIXERS);

export const config = createConfig({
  projectName: "skynet",
  devDir,
  lockPrefix: "/tmp/skynet-skynet",
  scriptsDir: resolve(repoRoot, "scripts"),
  maxFixers: Number.isFinite(maxFixersEnv) && maxFixersEnv > 0 ? maxFixersEnv : undefined,
});
