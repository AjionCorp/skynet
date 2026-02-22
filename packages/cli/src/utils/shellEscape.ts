/**
 * Shell-escape a value for safe embedding in bash double-quoted strings.
 * Escapes: " \ $ ` ! \n \r
 */
export function shellEscape(s: string): string {
  return s.replace(/["\\$`!\n\r]/g, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    return "\\" + ch;
  });
}

/**
 * Reject values containing obvious shell injection patterns.
 * Returns an error message or null if the value looks safe.
 */
export function validateShellValue(value: string): string | null {
  if (/[`]|\$\(|;|\n|\r/.test(value)) {
    return "Value contains disallowed shell characters";
  }
  return null;
}
