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

  // Track which keys use double-quoted values (need variable expansion)
  const needsExpansion: string[] = [];

  for (const line of content.split("\n")) {
    const match = line.match(/^(?:export\s+)?(\w+)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/);
    if (match) {
      // match[2] = double-quoted value, match[3] = single-quoted value
      // Unquoted values are rejected to prevent shell metacharacter issues
      const isSingleQuoted = match[3] !== undefined;
      let value = match[2] ?? match[3];
      if (!isSingleQuoted) {
        // Unescape bash double-quote escape sequences (\\ and \").
        // NOTE: Only \\ and \" are handled. More exotic escapes (\t, \a, \$, etc.)
        // are not supported — config values are expected to use simple quoting.
        value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        // First pass: resolve references to already-collected vars and ALLOWED_ENV.
        // Unknown vars are kept as-is (e.g., "$SKYNET_BASE") for the second pass
        // to resolve forward references.
        value = value.replace(/\$\{?(\w+)\}?/g, (fullMatch, key) => {
          if (key in vars) return vars[key];
          if (ALLOWED_ENV.has(key)) return sanitizeEnvValue(process.env[key] || "");
          return fullMatch;  // preserve for second pass
        });
        needsExpansion.push(match[1]);
      }
      vars[match[1]] = value;
    }
  }

  // Second pass: resolve forward references. A var may reference another var
  // that was defined later in the file. Now that all vars are collected, re-expand.
  // Any still-unresolved references become empty string (unknown vars).
  for (const key of needsExpansion) {
    vars[key] = vars[key].replace(/\$\{?(\w+)\}?/g, (_, varName) => {
      if (varName in vars) return vars[varName];
      if (ALLOWED_ENV.has(varName)) return sanitizeEnvValue(process.env[varName] || "");
      return "";
    });
  }

  return vars;
}
