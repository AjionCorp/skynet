/**
 * Shell-escape a value for safe embedding in bash double-quoted strings.
 * Escapes: " \ $ ` !
 */
export function shellEscape(s: string): string {
  return s.replace(/["\\$`!]/g, "\\$&");
}

/**
 * Reject values containing obvious shell injection patterns.
 * Returns an error message or null if the value looks safe.
 */
export function validateShellValue(value: string): string | null {
  if (/[`]|\$\(|;/.test(value)) {
    return `Value contains disallowed shell characters: ${value}`;
  }
  return null;
}
