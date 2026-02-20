import { readFileSync, existsSync, statfsSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";

interface ValidateOptions {
  dir?: string;
}

function loadConfig(projectDir: string): Record<string, string> | null {
  const configPath = join(projectDir, ".dev/skynet.config.sh");
  if (!existsSync(configPath)) {
    return null;
  }

  const content = readFileSync(configPath, "utf-8");
  const vars: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const match = line.match(/^export\s+(\w+)="(.*)"/);
    if (match) {
      let value = match[2];
      value = value.replace(/\$\{?(\w+)\}?/g, (_, key) => vars[key] || process.env[key] || "");
      vars[match[1]] = value;
    }
  }

  return vars;
}

type Status = "PASS" | "WARN" | "FAIL";

function label(status: Status): string {
  switch (status) {
    case "PASS": return "[PASS]";
    case "WARN": return "[WARN]";
    case "FAIL": return "[FAIL]";
  }
}

export async function validateCommand(options: ValidateOptions) {
  const projectDir = resolve(options.dir || process.cwd());
  const results: { name: string; status: Status }[] = [];

  console.log(`\n  Skynet Validate — Pre-flight checks for ${projectDir}\n`);

  // --- (1) Quality Gates ---
  console.log("  Quality Gates:");

  const vars = loadConfig(projectDir);

  if (!vars) {
    console.log("    skynet.config.sh not found — cannot check gates");
    console.log("    Run 'skynet init' first.");
    results.push({ name: "Quality Gates", status: "FAIL" });
  } else {
    let gateIdx = 1;
    let gatesFound = 0;
    let gatesFailed = 0;

    while (true) {
      const gateCmd = vars[`SKYNET_GATE_${gateIdx}`];
      if (!gateCmd) break;

      gatesFound++;
      console.log(`    Gate ${gateIdx}: ${gateCmd}`);

      try {
        execSync(gateCmd, {
          cwd: projectDir,
          stdio: ["ignore", "ignore", "ignore"],
          timeout: 120000,
        });
        console.log(`      Result: PASS`);
      } catch {
        console.log(`      Result: FAIL`);
        gatesFailed++;
      }

      gateIdx++;
    }

    if (gatesFound === 0) {
      console.log("    No SKYNET_GATE_N variables defined in config");
      results.push({ name: "Quality Gates", status: "WARN" });
    } else if (gatesFailed > 0) {
      console.log(`    ${gatesFailed}/${gatesFound} gate(s) failed`);
      results.push({ name: "Quality Gates", status: "FAIL" });
    } else {
      console.log(`    ${gatesFound}/${gatesFound} gate(s) passed`);
      results.push({ name: "Quality Gates", status: "PASS" });
    }
  }

  // --- (2) Git Remote ---
  console.log("\n  Git Remote:");

  try {
    execSync("git ls-remote origin HEAD", {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    console.log("    Remote 'origin' is accessible");
    results.push({ name: "Git Remote", status: "PASS" });
  } catch {
    console.log("    Cannot reach remote 'origin' — check your git remote and credentials");
    results.push({ name: "Git Remote", status: "FAIL" });
  }

  // --- (3) Disk Space ---
  console.log("\n  Disk Space:");

  try {
    const stats = statfsSync(projectDir);
    const freeBytes = stats.bfree * stats.bsize;
    const freeGB = freeBytes / (1024 * 1024 * 1024);
    const freeFormatted = freeGB.toFixed(1);

    if (freeGB < 1) {
      console.log(`    Free space: ${freeFormatted} GB — low disk space`);
      results.push({ name: "Disk Space", status: "WARN" });
    } else {
      console.log(`    Free space: ${freeFormatted} GB`);
      results.push({ name: "Disk Space", status: "PASS" });
    }
  } catch {
    console.log("    Could not check disk space");
    results.push({ name: "Disk Space", status: "WARN" });
  }

  // --- (4) Mission File ---
  console.log("\n  Mission File:");

  const devDir = vars?.SKYNET_DEV_DIR || `${projectDir}/.dev`;
  const missionPath = join(devDir, "mission.md");

  if (!existsSync(missionPath)) {
    console.log("    .dev/mission.md not found");
    results.push({ name: "Mission File", status: "FAIL" });
  } else {
    try {
      const content = readFileSync(missionPath, "utf-8").trim();
      if (content.length === 0) {
        console.log("    .dev/mission.md exists but is empty");
        results.push({ name: "Mission File", status: "FAIL" });
      } else {
        const lines = content.split("\n").filter((l) => l.trim().length > 0).length;
        console.log(`    .dev/mission.md: OK (${lines} non-empty line${lines === 1 ? "" : "s"})`);
        results.push({ name: "Mission File", status: "PASS" });
      }
    } catch {
      console.log("    Could not read .dev/mission.md");
      results.push({ name: "Mission File", status: "FAIL" });
    }
  }

  // --- Summary ---
  console.log("\n  Summary:");

  for (const r of results) {
    console.log(`    ${label(r.status)} ${r.name}`);
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  const total = results.length;

  console.log(`\n  ${passed}/${total} pre-flight checks passed.\n`);

  const fails = results.filter((r) => r.status === "FAIL").length;
  if (fails > 0) {
    process.exit(1);
  }
}
