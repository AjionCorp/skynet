import { readFileSync, existsSync } from "fs";
import { join } from "path";

/** Only these environment variables may be expanded in config values. */
const ALLOWED_ENV = new Set(["HOME", "USER"]);

/** Strip shell metacharacters from env values to prevent injection. */
function sanitizeEnvValue(raw: string): string {
  return raw.replace(/[;|&$`(){}<>\n\r\\'"]/g, "");
}

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
      value = value.replace(/\$\{?(\w+)\}?/g, (_, key) => {
        if (key in vars) return vars[key];
        if (ALLOWED_ENV.has(key)) return sanitizeEnvValue(process.env[key] || "");
        return "";
      });
      vars[match[1]] = value;
    }
  }

  return vars;
}
