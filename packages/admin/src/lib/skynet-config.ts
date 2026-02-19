import { resolve } from "path";
import { createConfig } from "@ajioncorp/skynet";

// Resolve .dev/ relative to the repo root (2 levels up from packages/admin)
const repoRoot = resolve(process.cwd(), "../..");
const devDir = resolve(repoRoot, ".dev");

export const config = createConfig({
  projectName: "skynet",
  devDir,
  lockPrefix: "/tmp/skynet-skynet",
  scriptsDir: resolve(repoRoot, "scripts"),
});
