import { readFileSync, existsSync } from "fs";
import { join } from "path";

export function loadConfig(projectDir: string): Record<string, string> | null {
  const configPath = join(projectDir, ".dev/skynet.config.sh");
  if (!existsSync(configPath)) {
    return null;
  }

  const content = readFileSync(configPath, "utf-8");
  const vars: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const match = line.match(/^export\s+(\w+)=(?:"(.*)"|(\S+))/);
    if (match) {
      let value = match[2] ?? match[3];
      value = value.replace(/\$\{?(\w+)\}?/g, (_, key) => vars[key] || process.env[key] || "");
      vars[match[1]] = value;
    }
  }

  return vars;
}
