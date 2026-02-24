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
    const match = line.match(/^export\s+(\w+)=(?:"(.*)"|'(.*)'|(\S+))/);
    if (match) {
      // match[2] = double-quoted value, match[3] = single-quoted value, match[4] = unquoted value
      const isSingleQuoted = match[3] !== undefined;
      let value = match[2] ?? match[3] ?? match[4];
      if (!isSingleQuoted) {
        // Unescape bash double-quote escape sequences (\\ and \").
        // NOTE: Only \\ and \" are handled. More exotic escapes (\t, \a, \$, etc.)
        // are not supported — config values are expected to use simple quoting.
        value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        // Single-quoted values in shell are literal — no variable expansion
        value = value.replace(/\$\{?(\w+)\}?/g, (_, key) => {
          if (key in vars) return vars[key];
          if (ALLOWED_ENV.has(key)) return sanitizeEnvValue(process.env[key] || "");
          return "";
        });
      }
      vars[match[1]] = value;
    }
  }

  return vars;
}
